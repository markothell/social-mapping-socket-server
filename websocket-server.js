// websocket-server.js
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.local';
require('dotenv').config({ path: envFile });

console.log('🔧 NODE_ENV:', process.env.NODE_ENV);
console.log('🧪 Loaded Mongo URI:', process.env.MONGODB_URI);

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');

// Add connection tracking and cleanup intervals - environment dependent
const CONNECTIONS_CLEANUP_INTERVAL = process.env.NODE_ENV === 'production' ? 30 * 1000 : 10 * 1000; // Prod: 30s, Dev: 10s
const STALE_CONNECTION_CLEANUP_INTERVAL = process.env.NODE_ENV === 'production' ? 120 * 1000 : 30 * 1000; // Prod: 2min, Dev: 30s
const MAX_RETRY_ATTEMPTS = 3;

// Connection limits based on server capacity
const MAX_CONNECTIONS = process.env.MAX_CONNECTIONS || (process.env.NODE_ENV === 'production' ? 25 : 25); // Render: 25, Dev: 25
const SOFT_LIMIT = Math.floor(MAX_CONNECTIONS * 0.8); // 80% of max = warning threshold

let connectionCount = 0;

// Track operations in progress to prevent duplicates
const operationsInProgress = new Set();

// Express setup
const app = express();

// Parse CLIENT_URL to handle multiple origins for Express CORS
const allowedOrigins = process.env.CLIENT_URL 
  ? process.env.CLIENT_URL.split(',').map(url => url.trim())
  : ["http://localhost:3000"];

console.log('🌐 CORS origins:', allowedOrigins);
console.log('🔍 Raw CLIENT_URL:', process.env.CLIENT_URL);

app.use(cors({
  origin: function (origin, callback) {
    console.log('🔍 Incoming origin:', origin);
    console.log('🔍 Allowed origins:', allowedOrigins);
    
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    
    // Normalize origins by removing trailing slashes for comparison
    const normalizedOrigin = origin.replace(/\/$/, '');
    const normalizedAllowed = allowedOrigins.map(url => url.replace(/\/$/, ''));
    
    if (normalizedAllowed.indexOf(normalizedOrigin) !== -1) {
      console.log('✅ Origin allowed:', origin);
      callback(null, true);
    } else {
      console.log('❌ Origin blocked:', origin);
      console.log('🔍 Normalized origin:', normalizedOrigin);
      console.log('🔍 Normalized allowed:', normalizedAllowed);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
}));
app.use(bodyParser.json());

// Create server ONCE
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["my-custom-header"],
    credentials: true
  }
});

// Store active connections and room memberships
const connections = new Map(); // socketId -> { userId, activityIds }
const activities = new Map(); // activityId -> Set of userIds

// MongoDB connection status
let isMongoConnected = false;
let Activity = null;
let User = null;

// Enhanced connection cleanup with memory management
setInterval(() => {
  const memoryUsage = process.memoryUsage();
  const rssInMB = Math.round(memoryUsage.rss / 1024 / 1024);
  const heapUsedInMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
  
  // Always log basic stats
  console.log(`Connections: ${connectionCount}, Activities: ${activities.size}, Memory: RSS ${rssInMB}MB, Heap ${heapUsedInMB}MB`);
  
  // Production: Less verbose logging, focus on warnings
  if (process.env.NODE_ENV === 'production') {
    // Only log warnings in production
    if (rssInMB > 1000) console.warn(`⚠️ High memory usage: ${rssInMB}MB RSS`);
    if (connectionCount > 200) console.warn(`⚠️ High connection count: ${connectionCount}`);
    if (activities.size > 50) console.warn(`⚠️ High activity count: ${activities.size}`);
  } else {
    // Development: More detailed logging
    console.log(`Connection map size: ${connections.size}`);
    if (operationsInProgress.size > 0) {
      console.log(`Operations in progress: ${operationsInProgress.size}`);
    }
  }
  
  // Clean up stale operations
  if (operationsInProgress.size > (process.env.NODE_ENV === 'production' ? 200 : 50)) {
    console.log(`Clearing ${operationsInProgress.size} stale operations`);
    operationsInProgress.clear();
  }
  
  // Force garbage collection if available (production: less frequent)
  const gcChance = process.env.NODE_ENV === 'production' ? 0.05 : 0.1; // 5% prod, 10% dev
  if (global.gc && Math.random() < gcChance) {
    global.gc();
  }
  
}, CONNECTIONS_CLEANUP_INTERVAL);

// Add periodic cleanup for stale connections
setInterval(() => {
  let cleaned = 0;
  
  // Clean up connections that might be stale
  for (const [socketId, connection] of connections.entries()) {
    if (!io.sockets.sockets.has(socketId)) {
      console.log(`Cleaning up stale connection: ${socketId}`);
      connections.delete(socketId);
      cleaned++;
      
      // Also clean up from activities map
      if (connection && connection.userId) {
        for (const activityId of connection.activityIds || []) {
          if (activities.has(activityId)) {
            activities.get(activityId).delete(connection.userId);
            // Clean up empty activities
            if (activities.get(activityId).size === 0) {
              activities.delete(activityId);
              console.log(`Cleaned up empty activity: ${activityId}`);
            }
          }
        }
      }
    }
  }
  
  // Clean up activities with no participants
  let emptyActivities = 0;
  for (const [activityId, participants] of activities.entries()) {
    if (participants.size === 0) {
      activities.delete(activityId);
      emptyActivities++;
    }
  }
  
  if (cleaned > 0 || emptyActivities > 0) {
    console.log(`Cleanup complete: ${cleaned} stale connections, ${emptyActivities} empty activities removed`);
  }
  
}, STALE_CONNECTION_CLEANUP_INTERVAL);

// Function to safely get participants from activities map
function getActivityParticipants(activityId) {
  if (!activities.has(activityId)) {
    return [];
  }
  
  const participantSet = activities.get(activityId);
  if (!participantSet) {
    return [];
  }
  
  return Array.from(participantSet);
}

// Function to load API routes once MongoDB is connected
let apiRoutesLoaded = false;

function loadAPIRoutes() {
  if (isMongoConnected && Activity && !apiRoutesLoaded) {
    try {
      const activityRoutes = require('./server/routes/activities');
      app.use('/api/activities', activityRoutes);
      apiRoutesLoaded = true;
      console.log('✅ API routes loaded successfully');
    } catch (error) {
      console.error('❌ Error loading API routes:', error.message);
    }
  }
}

// Handle MongoDB connection
console.log("MongoDB URI:", process.env.MONGODB_URI ? "Set" : "Not set");

if (process.env.MONGODB_URI) {
  // Append socialmap1-db database name to the URI
  let mongoUri = process.env.MONGODB_URI;
  
  // Remove any existing database name from the URI
  const uriParts = mongoUri.split('/');
  if (uriParts.length > 3) {
    // Remove the last part (database name) and any query params
    const baseUri = uriParts.slice(0, 3).join('/');
    const queryParams = mongoUri.includes('?') ? '?' + mongoUri.split('?')[1] : '';
    mongoUri = baseUri + '/socialmap1-db' + queryParams;
  } else {
    mongoUri = mongoUri + '/socialmap1-db';
  }
  
  console.log("🗃️  Using database: socialmap1-db");
  
  mongoose.connect(mongoUri, {
    // Connection pool limits to prevent resource exhaustion
    maxPoolSize: process.env.NODE_ENV === 'production' ? 20 : 3,    // Production: 20, Dev: 3
    minPoolSize: process.env.NODE_ENV === 'production' ? 5 : 1,     // Production: 5, Dev: 1
    maxIdleTimeMS: process.env.NODE_ENV === 'production' ? 30000 : 15000, // Production: 30s, Dev: 15s
    
    // Timeout settings to fail fast instead of hanging
    serverSelectionTimeoutMS: 5000,  // 5s timeout for server selection
    socketTimeoutMS: 45000,          // 45s timeout for socket operations
    connectTimeoutMS: 10000,         // 10s timeout for initial connection
    
    // Heartbeat settings
    heartbeatFrequencyMS: 10000,     // Check server every 10s
  })
  .then(async () => {
    console.log('✅ Connected to MongoDB');
    isMongoConnected = true;
    
    // Load models after successful connection
    try {
      Activity = require('./server/models/Activity');
      User = require('./server/models/User');
      console.log('✅ MongoDB models loaded');
      
      // IMPORTANT: Load API routes AFTER MongoDB connection is established
      loadAPIRoutes();
      
      // Test the connection by listing collections
      const collections = await mongoose.connection.db.listCollections().toArray();
      console.log('MongoDB collections:', collections.map(c => c.name));
      
      // Check if activities collection exists
      const activitiesCollection = collections.find(c => c.name === 'activities');
      if (activitiesCollection) {
        const count = await mongoose.connection.db.collection('activities').countDocuments();
        console.log(`Found ${count} activities in MongoDB`);
      } else {
        console.log('Activities collection does not exist yet');
      }
    } catch (error) {
      console.error('Error loading models or testing connection:', error);
    }
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    console.log('🔄 Continuing without MongoDB connection - using fallback routes');
    isMongoConnected = false;
  });

  // Handle MongoDB connection events
  const db = mongoose.connection;
  
  db.on('error', (error) => {
    console.error('MongoDB connection error:', error.message);
    isMongoConnected = false;
  });

  db.on('disconnected', () => {
    console.log('MongoDB disconnected');
    isMongoConnected = false;
  });

  db.on('reconnected', () => {
    console.log('MongoDB reconnected');
    isMongoConnected = true;
    
    // Try to reload API routes when reconnected
    if (!app._router || !app._router.stack.some(layer => layer.regexp.test('/api/activities'))) {
      console.log('🔄 Reloading API routes after reconnection');
      loadAPIRoutes();
    }
  });
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    try {
      if (isMongoConnected) {
        await mongoose.connection.close();
        console.log('MongoDB connection closed due to app termination');
      }
      process.exit(0);
    } catch (error) {
      console.error('Error closing MongoDB connection:', error);
      process.exit(1);
    }
  });
} else {
  console.log('🔄 No MongoDB URI provided - using fallback routes only');
}

// Add a health check route
app.get('/health', (req, res) => {
  const capacityStatus = connectionCount >= MAX_CONNECTIONS ? 'full' : 
                        connectionCount >= SOFT_LIMIT ? 'high' : 'normal';
  
  res.json({ 
    status: 'ok', 
    message: 'WebSocket server is running',
    mongodb: isMongoConnected ? 'connected' : 'disconnected',
    connections: connectionCount,
    capacity: {
      current: connectionCount,
      max: MAX_CONNECTIONS,
      softLimit: SOFT_LIMIT,
      status: capacityStatus,
      availableSlots: Math.max(0, MAX_CONNECTIONS - connectionCount)
    },
    apiRoutesLoaded: isMongoConnected && Activity ? true : false
  });
});

// Safe database operations
async function safeDbOperation(operation, fallback = null) {
  if (!isMongoConnected || !Activity) {
    console.log('Database operation skipped - MongoDB not connected');
    return fallback;
  }
  
  try {
    return await operation();
  } catch (error) {
    console.error('Database operation failed:', error.message);
    return fallback;
  }
}

// Handle socket connections
io.on('connection', (socket) => {
  // Check connection limits before accepting
  if (connectionCount >= MAX_CONNECTIONS) {
    console.log(`❌ Connection rejected: at capacity (${connectionCount}/${MAX_CONNECTIONS})`);
    socket.emit('connection_rejected', {
      reason: 'capacity_full',
      message: 'Sorry! We\'re at capacity right now. Please try again in a few minutes.',
      currentConnections: connectionCount,
      maxConnections: MAX_CONNECTIONS,
      estimatedWaitTime: '2-5 minutes'
    });
    socket.disconnect(true);
    return;
  }

  connectionCount++;
  console.log(`✅ User connected: ${socket.id} (Total: ${connectionCount}/${MAX_CONNECTIONS})`);
  connections.set(socket.id, { userId: null, activityIds: new Set() });
  
  // Send capacity warning if approaching limit
  if (connectionCount >= SOFT_LIMIT) {
    socket.emit('capacity_warning', {
      message: 'High traffic detected - you may experience slower performance.',
      currentConnections: connectionCount,
      maxConnections: MAX_CONNECTIONS
    });
  }
  
  // Send welcome message with capacity info
  socket.emit('connection_accepted', {
    message: 'Connected successfully!',
    currentConnections: connectionCount,
    maxConnections: MAX_CONNECTIONS,
    capacityLevel: connectionCount < SOFT_LIMIT ? 'normal' : 'high'
  });
  
  // Handle create activity
  socket.on('create_activity', (data) => {
    const { activityId } = data;
    console.log(`📝 User ${socket.id} created activity ${activityId}`);
    
    // Broadcast to all OTHER clients
    socket.broadcast.emit('activity_created', {
      activityId,
      createdAt: new Date().toISOString()
    });
  });

  // Handle update activity
  socket.on('update_activity', (data) => {
    const { activityId } = data;
    console.log(`🔄 User ${socket.id} updated activity ${activityId}`);
    
    // Broadcast to all OTHER clients
    socket.broadcast.emit('activity_updated', {
      activityId,
      updatedAt: new Date().toISOString()
    });
  });

  // Handle joining an activity
  socket.on('join_activity', async ({ activityId, userId, userName }) => {
    console.log(`👋 User ${userName} (${userId}) joining activity ${activityId}`);
    
    // Check if user is already in this activity to prevent duplicates
    const connection = connections.get(socket.id);
    if (connection && connection.activityIds.has(activityId)) {
      console.log(`⚠️ User ${userName} (${userId}) is already in activity ${activityId}, skipping join`);
      return;
    }
    
    // Update connections map
    if (connection) {
      connection.userId = userId;
      connection.activityIds.add(activityId);
    }
    
    // Add user to activity participants
    if (!activities.has(activityId)) {
      activities.set(activityId, new Set());
    }
    activities.get(activityId).add(userId);
    
    // Join socket.io room for this activity
    socket.join(activityId);
    
    // Update participants in MongoDB (if available)
    await safeDbOperation(async () => {
      const activity = await Activity.findOne({ id: activityId });
      if (activity) {
        // Check if participant already exists
        const existingParticipant = activity.participants.find(p => p.id === userId);
        if (existingParticipant) {
          existingParticipant.isConnected = true;
        } else {
          // Add new participant with required name field
          activity.participants.push({
            id: userId,
            name: userName || `User-${userId.substring(0, 6)}`,
            isConnected: true
          });
        }
        activity.updatedAt = new Date();
        await activity.save();
        console.log(`💾 Updated participants in database for activity ${activityId}`);
      }
    });
    
    // Notify other participants
    const participantIds = getActivityParticipants(activityId);
    const participants = participantIds.map(id => ({
      id,
      name: id === userId ? userName : `User-${id.substring(0, 6)}`,
      isConnected: true,
    }));
    
    io.to(activityId).emit('participants_updated', {
      activityId,
      participants
    });
    
    console.log(`📢 Notified ${participants.length} participants about join`);
  });
    
  // Handle leaving an activity
  socket.on('leave_activity', async ({ activityId, userId }) => {
    if (!userId || !activityId) {
      console.warn('⚠️ leave_activity called without required parameters');
      return;
    }
    
    // Create operation key to prevent duplicates
    const operationKey = `leave_${activityId}_${userId}`;
    if (operationsInProgress.has(operationKey)) {
      console.log(`⏳ Leave operation already in progress for ${userId} in ${activityId}`);
      return;
    }
    
    operationsInProgress.add(operationKey);
    
    try {
      console.log(`👋 User ${userId} leaving activity ${activityId}`);
      
      // Update connections map
      const connection = connections.get(socket.id);
      if (connection) {
        connection.activityIds.delete(activityId);
      }
      
      // Remove from in-memory activity tracking
      if (activities.has(activityId) && activities.get(activityId).has(userId)) {
        activities.get(activityId).delete(userId);
        
        // Clean up empty activities
        if (activities.get(activityId).size === 0) {
          activities.delete(activityId);
        }
        
        socket.leave(activityId);
        
        // Update database (if available)
        await safeDbOperation(async () => {
          const result = await Activity.updateOne(
            { 
              id: activityId, 
              "participants.id": userId 
            },
            { 
              $set: { 
                "participants.$.isConnected": false,
                updatedAt: new Date()
              } 
            }
          );
          
          if (result.modifiedCount > 0) {
            console.log(`💾 Updated participant ${userId} status in database`);
          }
        });
        
        // Send participant updates
        const participantIds = getActivityParticipants(activityId);
        const participants = participantIds.map(id => ({
          id,
          name: `User-${id.substring(0, 6)}`,
          isConnected: true,
        }));
        
        io.to(activityId).emit('participants_updated', {
          activityId,
          participants
        });
        
        console.log(`📢 Notified about user ${userId} leaving`);
      }
      
    } catch (error) {
      console.error(`❌ Error in leave_activity handler: ${error.message}`);
    } finally {
      operationsInProgress.delete(operationKey);
    }
  });
  
  // Handle activity deletion
  socket.on('delete_activity', async (data) => {
    try {
      const { activityId } = data;
      console.log(`🗑️ User ${socket.id} requested deletion of activity ${activityId}`);
      
      // Attempt to delete from database (if available)
      const deleted = await safeDbOperation(async () => {
        const result = await Activity.deleteOne({ id: activityId });
        return result.deletedCount > 0;
      }, false);
      
      if (deleted) {
        console.log(`💾 Successfully deleted activity ${activityId} from database`);
      }
      
      // Always broadcast deletion (even if database fails)
      io.emit('activity_deleted', { activityId });
      console.log(`📢 Notified all clients about deletion of activity ${activityId}`);
      
    } catch (error) {
      console.error(`❌ Error handling delete_activity event: ${error.message}`);
    }
  });

  // Handle tag updates
  socket.on('add_tag', async (data) => {
    try {
      console.log(`🏷️ Processing add_tag event for ${data.activityId}, tag ${data.tag.id}`);
      
      // Save to database (if available)
      await safeDbOperation(async () => {
        const activity = await Activity.findOne({ id: data.activityId });
        if (!activity) {
          console.log(`Activity ${data.activityId} not found for tag addition`);
          return;
        }
        
        // Check if tag already exists
        const existingTag = activity.tags.find(t => t.id === data.tag.id);
        if (existingTag) {
          console.log(`Tag ${data.tag.id} already exists, skipping`);
          return;
        }
        
        // Add the tag
        activity.tags.push({
          ...data.tag,
          votes: data.tag.votes || [],
          comments: data.tag.comments || [],
          commentCount: 0,
          hasNewComments: false,
          status: activity.settings.tagCreation?.enableVoting ? 'pending' : 'approved',
          createdAt: new Date()
        });
        
        activity.updatedAt = new Date();
        await activity.save();
        console.log(`💾 Tag ${data.tag.id} saved to database`);
      });
      
      // Broadcast to other clients
      socket.to(data.activityId).emit('tag_added', data);
      console.log(`📢 tag_added event broadcast to room ${data.activityId}`);
      
    } catch (error) {
      console.error('❌ Error handling add_tag event:', error.message);
    }
  });

  // Handle other socket events with similar safe patterns...
  socket.on('vote_tag', async (data) => {
    try {
      await safeDbOperation(async () => {
        const activity = await Activity.findOne({ id: data.activityId });
        if (activity) {
          const tag = activity.tags.find(t => t.id === data.tagId);
          if (tag) {
            const existingVoteIndex = tag.votes.findIndex(v => v.userId === data.vote.userId);
            
            if (existingVoteIndex !== -1) {
              tag.votes.splice(existingVoteIndex, 1);
            } else {
              tag.votes.push({
                userId: data.vote.userId,
                userName: data.vote.userName,
                timestamp: new Date(data.vote.timestamp)
              });
            }
            
            // Update tag status based on current vote count and threshold
            const tagCreationSettings = activity.settings?.tagCreation;
            if (tagCreationSettings?.enableVoting) {
              const thresholdType = tagCreationSettings.thresholdType || 'minimum';
              const minimumVotes = tagCreationSettings.minimumVotes || tagCreationSettings.voteThreshold || 1;
              
              if (thresholdType === 'minimum') {
                if (tag.status === 'pending' && tag.votes.length >= minimumVotes) {
                  tag.status = 'approved';
                } else if (tag.status === 'approved' && tag.votes.length < minimumVotes) {
                  tag.status = 'pending';
                }
              }
              // Note: topN threshold requires complex recalculation handled by hybridActivityService
              // to avoid race conditions between multiple processing systems
            }
            
            activity.updatedAt = new Date();
            await activity.save();
          }
        }
      });
      
      socket.to(data.activityId).emit('tag_voted', data);
    } catch (error) {
      console.error('❌ Error handling vote_tag event:', error.message);
    }
  });

  socket.on('delete_tag', async (data) => {
    try {
      await safeDbOperation(async () => {
        const activity = await Activity.findOne({ id: data.activityId });
        if (activity) {
          activity.tags = activity.tags.filter(t => t.id !== data.tagId);
          activity.updatedAt = new Date();
          await activity.save();
        }
      });
      
      socket.to(data.activityId).emit('tag_deleted', data);
    } catch (error) {
      console.error('❌ Error handling delete_tag event:', error.message);
    }
  });

  socket.on('update_mapping', async (data) => {
    try {
      await safeDbOperation(async () => {
        const activity = await Activity.findOne({ id: data.activityId });
        if (activity) {
          const userMappingIndex = activity.mappings.findIndex(m => m.userId === data.userId);
          
          if (userMappingIndex >= 0) {
            activity.mappings[userMappingIndex].positions = data.positions;
            if (data.isComplete !== undefined) {
              activity.mappings[userMappingIndex].isComplete = data.isComplete;
            }
          } else {
            const participant = activity.participants.find(p => p.id === data.userId);
            const userName = participant ? participant.name : 'Unknown';
            
            activity.mappings.push({
              userId: data.userId,
              userName,
              positions: data.positions,
              isComplete: data.isComplete || false
            });
          }
          
          activity.updatedAt = new Date();
          await activity.save();
        }
      });
      
      socket.to(data.activityId).emit('mapping_updated', data);
    } catch (error) {
      console.error('❌ Error handling update_mapping event:', error.message);
    }
  });

  socket.on('change_phase', async (data) => {
    try {
      await safeDbOperation(async () => {
        const activity = await Activity.findOne({ id: data.activityId });
        if (activity) {
          activity.phase = data.phase;
          activity.updatedAt = new Date();
          await activity.save();
        }
      });
      
      socket.to(data.activityId).emit('phase_changed', data);
    } catch (error) {
      console.error('❌ Error handling change_phase event:', error.message);
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', async () => {
    connectionCount--;
    console.log(`❌ User disconnected: ${socket.id} (Total: ${connectionCount})`);
    
    const connection = connections.get(socket.id);
    if (connection && connection.userId) {
      const userId = connection.userId;
      
      // Process each activity this user was in
      for (const activityId of connection.activityIds) {
        try {
          if (activities.has(activityId)) {
            activities.get(activityId).delete(userId);
            
            // Clean up empty activities
            if (activities.get(activityId).size === 0) {
              activities.delete(activityId);
            }
          }
          
          // Update database (if available)
          await safeDbOperation(async () => {
            await Activity.updateOne(
              { 
                id: activityId, 
                "participants.id": userId 
              },
              { 
                $set: { 
                  "participants.$.isConnected": false,
                  updatedAt: new Date()
                } 
              }
            );
          });
          
        } catch (error) {
          console.error(`❌ Error processing disconnect for activity ${activityId}:`, error.message);
        }
      }
    }
    
    // Clean up connection
    connections.delete(socket.id);
  });
});

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
  console.log(`📊 MongoDB connected: ${isMongoConnected}`);
  console.log(`🌐 CORS origins: ${allowedOrigins.join(', ')}`);
});
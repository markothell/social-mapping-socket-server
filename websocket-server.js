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

// Add connection tracking and cleanup intervals
const CONNECTIONS_CLEANUP_INTERVAL = 30 * 1000; // 30 seconds
const MAX_RETRY_ATTEMPTS = 3;
let connectionCount = 0;

// Track operations in progress to prevent duplicates
const operationsInProgress = new Set();

// Express setup
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Create server ONCE
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
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
  console.log(`Active connections: ${connectionCount}`);
  
  // Force garbage collection if available
  if (global.gc) {
    console.log('Running garbage collection');
    global.gc();
  }
  
  // Log memory usage
  const memoryUsage = process.memoryUsage();
  console.log(`Memory usage: ${Math.round(memoryUsage.rss / 1024 / 1024)} MB`);
  
  // Clean up stale operations
  operationsInProgress.clear();
  
}, CONNECTIONS_CLEANUP_INTERVAL);

// Add periodic cleanup for stale connections
setInterval(() => {
  // Clean up any stale operations
  if (operationsInProgress.size > 100) {
    console.warn(`Clearing ${operationsInProgress.size} stale operations`);
    operationsInProgress.clear();
  }
  
  // Clean up connections that might be stale
  for (const [socketId, connection] of connections.entries()) {
    if (!io.sockets.sockets.has(socketId)) {
      console.log(`Cleaning up stale connection: ${socketId}`);
      connections.delete(socketId);
    }
  }
}, 60000); // Every minute

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
  mongoose.connect(process.env.MONGODB_URI, {
    // Connection pool limits to prevent resource exhaustion
    maxPoolSize: 10,          // Max number of connections in pool
    minPoolSize: 2,           // Min number of connections in pool
    maxIdleTimeMS: 30000,     // Close connections after 30s of inactivity
    
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
  res.json({ 
    status: 'ok', 
    message: 'WebSocket server is running',
    mongodb: isMongoConnected ? 'connected' : 'disconnected',
    connections: connectionCount,
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
  connectionCount++;
  console.log(`✅ User connected: ${socket.id} (Total: ${connectionCount})`);
  connections.set(socket.id, { userId: null, activityIds: new Set() });
  
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
  console.log(`🌐 CORS origin: ${process.env.CLIENT_URL || "http://localhost:3000"}`);
});
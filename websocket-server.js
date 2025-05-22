// websocket-server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
require('dotenv').config();

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

// API Routes
const activityRoutes = require('./server/routes/activities');
app.use('/api/activities', activityRoutes);

// MongoDB connection - using let to track connection status
let isMongoConnected = false;

// Handle MongoDB connection
console.log("MongoDB URI:", process.env.MONGODB_URI);
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
    
    // Buffer settings
    bufferMaxEntries: 0,             // Disable mongoose buffering
    bufferCommands: false,           // Disable mongoose buffering
  })
  .then(async () => {
    console.log('Connected to MongoDB');
    isMongoConnected = true;
    
    // Test the connection by listing collections
    try {
      const collections = await mongoose.connection.db.listCollections().toArray();
      console.log('MongoDB collections:', collections.map(c => c.name));
      
      // Check Activity model schema
      console.log('Activity schema paths:', Object.keys(Activity.schema.paths));
      
      // DISABLE mongoose debug mode in production to reduce memory usage
      if (process.env.NODE_ENV !== 'production') {
        mongoose.set('debug', true);
      }
      
      // Check if activities collection exists
      const activitiesCollection = collections.find(c => c.name === 'activities');
      if (activitiesCollection) {
        const count = await mongoose.connection.db.collection('activities').countDocuments();
        console.log(`Found ${count} activities in MongoDB`);
        
        // List all activity IDs
        const activityIds = await mongoose.connection.db
          .collection('activities')
          .find({}, { projection: { id: 1 } })
          .toArray();
        console.log('Activity IDs in MongoDB:', activityIds.map(a => a.id));
      } else {
        console.log('Activities collection does not exist yet');
      }
    } catch (error) {
      console.error('Error testing MongoDB connection:', error);
    }
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    console.log('Continuing without MongoDB connection...');
  });

  // Handle MongoDB connection events
  const db = mongoose.connection;
  
  db.on('error', (error) => {
    console.error('MongoDB connection error:', error);
  });

  db.on('disconnected', () => {
    console.log('MongoDB disconnected, attempting to reconnect...');
  });

  db.on('reconnected', () => {
    console.log('MongoDB reconnected');
  });
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    try {
      await mongoose.connection.close();
      console.log('MongoDB connection closed due to app termination');
      process.exit(0);
    } catch (error) {
      console.error('Error closing MongoDB connection:', error);
      process.exit(1);
    }
  });
}

// Load database models
const Activity = require('./server/models/Activity');
const User = require('./server/models/User');

// Store active connections and room memberships
const connections = new Map(); // socketId -> { userId, activityIds }
const activities = new Map(); // activityId -> Set of userIds

// Handle socket connections
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  connections.set(socket.id, { userId: null, activityIds: new Set() });
  
  //Handle create activity
  socket.on('create_activity', (data) => {
    const { activityId } = data;
    console.log(`User ${socket.id} created activity ${activityId}`);
    
    // Broadcast to all OTHER clients
    socket.broadcast.emit('activity_created', {
      activityId,
      createdAt: new Date().toISOString()
    });
  });

  //Handle update activity
  socket.on('update_activity', (data) => {
    const { activityId } = data;
    console.log(`User ${socket.id} updated activity ${activityId}`);
    
    // Broadcast to all OTHER clients
    socket.broadcast.emit('activity_updated', {
      activityId,
      updatedAt: new Date().toISOString()
    });
  });

  // Handle joining an activity
  socket.on('join_activity', async ({ activityId, userId, userName }) => {
    console.log(`User ${userName} (${userId}) joining activity ${activityId}`);
    
    // Check if user is already in this activity to prevent duplicates
    const connection = connections.get(socket.id);
    if (connection && connection.activityIds.has(activityId)) {
      console.log(`User ${userName} (${userId}) is already in activity ${activityId}, skipping join`);
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
    
    // Update participants in MongoDB
    try {
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
            name: userName || `User-${userId.substring(0, 6)}`, // Ensure name is provided
            isConnected: true
          });
        }
        activity.updatedAt = new Date();
        await activity.save();
      }
    } catch (error) {
      console.error(`Error updating participants for activity ${activityId}:`, error);
    }
    
    // Notify other participants
    const participants = Array.from(activities.get(activityId)).map(id => ({
      id,
      name: id === userId ? userName : '', // Add name for the current user
      isConnected: true,
    }));
    
    io.to(activityId).emit('participants_updated', {
      activityId,
      participants
    });
  });
    
  // Handle leaving an activity
  // Fixed leave_activity handler with proper error handling and deduplication
  socket.on('leave_activity', async ({ activityId, userId }) => {
    if (!userId || !activityId) {
      console.warn('leave_activity called without required parameters');
      return;
    }
    
    // Create operation key to prevent duplicates
    const operationKey = `leave_${activityId}_${userId}`;
    if (operationsInProgress.has(operationKey)) {
      console.log(`Leave operation already in progress for ${userId} in ${activityId}`);
      return;
    }
    
    operationsInProgress.add(operationKey);
    
    try {
      console.log(`User ${userId} leaving activity ${activityId}`);
      
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
        
        // Update database with retry logic and timeout
        let retryCount = 0;
        let updateSuccessful = false;
        
        while (retryCount < MAX_RETRY_ATTEMPTS && !updateSuccessful) {
          try {
            console.log(`Attempting to update participant status (attempt ${retryCount + 1}/${MAX_RETRY_ATTEMPTS})`);
            
            const result = await Promise.race([
              Activity.updateOne(
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
              ),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Database operation timeout')), 5000)
              )
            ]);
            
            if (result.modifiedCount > 0) {
              console.log(`Successfully updated participant ${userId} status in activity ${activityId}`);
              updateSuccessful = true;
            } else {
              console.log(`No participant found to update for user ${userId} in activity ${activityId}`);
              updateSuccessful = true; // Don't retry if participant doesn't exist
            }
            
          } catch (error) {
            retryCount++;
            console.error(`Database update attempt ${retryCount} failed:`, error.message);
            
            if (retryCount < MAX_RETRY_ATTEMPTS) {
              // Exponential backoff
              await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
            }
          }
        }
        
        if (!updateSuccessful) {
          console.error(`Failed to update participant status after ${MAX_RETRY_ATTEMPTS} attempts for user ${userId}`);
        }
        
        // Send participant updates regardless of database success
        try {
          const activity = await Activity.findOne({ id: activityId }).lean();
          if (activity) {
            const connectedUsers = new Set();
            if (activities.has(activityId)) {
              activities.get(activityId).forEach(id => connectedUsers.add(id));
            }
            
            const fullParticipantsList = activity.participants.map(p => ({
              id: p.id,
              name: p.name || `User-${p.id.substring(0, 6)}`,
              isConnected: connectedUsers.has(p.id)
            }));
            
            io.to(activityId).emit('participants_updated', {
              activityId,
              participants: fullParticipantsList
            });
          }
        } catch (error) {
          console.error(`Error sending participant updates: ${error.message}`);
        }
      }
      
    } catch (error) {
      console.error(`Error in leave_activity handler: ${error.message}`);
    } finally {
      operationsInProgress.delete(operationKey);
    }
  });
  
  // Add a handler for activity deletion
  socket.on('delete_activity', async (data) => {
    try {
      const { activityId } = data;
      console.log(`User ${socket.id} requested deletion of activity ${activityId}`);
      
      // Attempt to delete from database
      const activity = await Activity.findOne({ id: activityId });
      if (!activity) {
        console.log(`Activity ${activityId} not found for deletion`);
        return;
      }
      
      const result = await Activity.deleteOne({ id: activityId });
      if (result.deletedCount > 0) {
        console.log(`Successfully deleted activity ${activityId} from database`);
        
        // Broadcast to all clients that this activity was deleted
        io.emit('activity_deleted', { activityId });
        console.log(`Notified all clients about deletion of activity ${activityId}`);
      } else {
        console.log(`Failed to delete activity ${activityId} from database`);
      }
    } catch (error) {
      console.error(`Error handling delete_activity event for ${data.activityId}:`, error);
    }
  });

  // Handle tag updates
  socket.on('add_tag', async (data) => {
    try {
      console.log(`Processing add_tag event for ${data.activityId}, tag ${data.tag.id} from socket ${socket.id}`);
      
      // First, save to database
      const activity = await Activity.findOne({ id: data.activityId });
      if (!activity) {
        console.log(`Activity ${data.activityId} not found for tag addition`);
        return;
      }
      
      // Check if tag already exists
      const existingTag = activity.tags.find(t => t.id === data.tag.id);
      if (existingTag) {
        console.log(`Tag ${data.tag.id} already exists in activity ${data.activityId}, skipping addition`);
        return;
      }
      
      // Add the tag (with complete tag object)
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
      console.log(`Tag ${data.tag.id} saved to database`);
      
      // IMPORTANT: Only broadcast tag_added, NOT activity_updated
      // This prevents the double event problem
      socket.to(data.activityId).emit('tag_added', data);
      console.log(`tag_added event broadcast to room ${data.activityId}`);
      
      // DO NOT emit activity_updated here!
    } catch (error) {
      console.error('Error handling add_tag event:', error);
    }
  });

  socket.on('vote_tag', async (data) => {
    try {
      const activity = await Activity.findOne({ id: data.activityId });
      if (activity) {
        const tag = activity.tags.find(t => t.id === data.tagId);
        if (tag) {
          // Check if user already voted
          const existingVoteIndex = tag.votes.findIndex(v => v.userId === data.vote.userId);
          
          if (existingVoteIndex !== -1) {
            // Remove vote
            tag.votes.splice(existingVoteIndex, 1);
          } else {
            // Add vote
            tag.votes.push({
              userId: data.vote.userId,
              userName: data.vote.userName,
              timestamp: new Date(data.vote.timestamp)
            });
            
            // Update tag status if threshold is reached
            if (
              activity.settings.tagCreation?.enableVoting && 
              tag.status === 'pending' && 
              tag.votes.length >= activity.settings.tagCreation.voteThreshold
            ) {
              tag.status = 'approved';
            }
          }
          
          activity.updatedAt = new Date();
          await activity.save();
        }
      }
      
      socket.to(data.activityId).emit('tag_voted', data);
    } catch (error) {
      console.error('Error handling vote_tag event:', error);
    }
  });

  socket.on('delete_tag', async (data) => {
    try {
      const activity = await Activity.findOne({ id: data.activityId });
      if (activity) {
        activity.tags = activity.tags.filter(t => t.id !== data.tagId);
        activity.updatedAt = new Date();
        await activity.save();
      }
      
      socket.to(data.activityId).emit('tag_deleted', data);
    } catch (error) {
      console.error('Error handling delete_tag event:', error);
    }
  });

  socket.on('update_mapping', async (data) => {
    try {
      const activity = await Activity.findOne({ id: data.activityId });
      if (activity) {
        const userMappingIndex = activity.mappings.findIndex(m => m.userId === data.userId);
        
        if (userMappingIndex >= 0) {
          activity.mappings[userMappingIndex].positions = data.positions;
          // Set isComplete flag if provided
          if (data.isComplete !== undefined) {
            activity.mappings[userMappingIndex].isComplete = data.isComplete;
          }
        } else {
          // Get user name from participants
          const participant = activity.participants.find(p => p.id === data.userId);
          const userName = participant ? participant.name : 'Unknown';
          
          activity.mappings.push({
            userId: data.userId,
            userName,
            positions: data.positions,
            isComplete: data.isComplete || false // Use provided isComplete or default to false
          });
        }
        
        activity.updatedAt = new Date();
        await activity.save();
      }
      
      socket.to(data.activityId).emit('mapping_updated', data);
    } catch (error) {
      console.error('Error handling update_mapping event:', error);
    }
  });

  socket.on('change_phase', async (data) => {
    try {
      const activity = await Activity.findOne({ id: data.activityId });
      if (activity) {
        activity.phase = data.phase;
        activity.updatedAt = new Date();
        await activity.save();
      }
      
      socket.to(data.activityId).emit('phase_changed', data);
    } catch (error) {
      console.error('Error handling change_phase event:', error);
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', async () => {
    connectionCount--;
    console.log(`User disconnected: ${socket.id} (Total: ${connectionCount})`);
    
    const connection = connections.get(socket.id);
    if (connection && connection.userId) {
      const userId = connection.userId;
      
      // Process each activity this user was in
      const activityPromises = Array.from(connection.activityIds).map(async (activityId) => {
        const operationKey = `disconnect_${activityId}_${userId}`;
        if (operationsInProgress.has(operationKey)) {
          return;
        }
        
        operationsInProgress.add(operationKey);
        
        try {
          if (activities.has(activityId)) {
            activities.get(activityId).delete(userId);
            
            // Clean up empty activities
            if (activities.get(activityId).size === 0) {
              activities.delete(activityId);
            }
          }
          
          // Update database with timeout and limited retries
          try {
            await Promise.race([
              Activity.updateOne(
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
              ),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout')), 3000)
              )
            ]);
            
            console.log(`Updated participant ${userId} to disconnected in activity ${activityId}`);
          } catch (error) {
            console.error(`Database update failed for disconnect: ${error.message}`);
            // Don't retry on disconnect - it's not critical
          }
          
        } finally {
          operationsInProgress.delete(operationKey);
        }
      });
      
      // Wait for all activity updates to complete (with timeout)
      try {
        await Promise.race([
          Promise.allSettled(activityPromises),
          new Promise(resolve => setTimeout(resolve, 10000)) // 10s max wait
        ]);
      } catch (error) {
        console.error('Error processing disconnect activities:', error.message);
      }
    }
    
    // Clean up connection
    connections.delete(socket.id);
  });

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
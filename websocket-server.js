// websocket-server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
require('dotenv').config();

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

// API Routes
const activityRoutes = require('./server/routes/activities');
app.use('/api/activities', activityRoutes);

// MongoDB connection - using let to track connection status
let isMongoConnected = false;

// Handle MongoDB connection
console.log("MongoDB URI:", process.env.MONGODB_URI);
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB');
    isMongoConnected = true;
    
    // Test the connection by listing collections
    try {
      const collections = await mongoose.connection.db.listCollections().toArray();
      console.log('MongoDB collections:', collections.map(c => c.name));
      
      // Check Activity model schema
      console.log('Activity schema paths:', Object.keys(Activity.schema.paths));
      
      // Enable mongoose debug mode to see all queries
      mongoose.set('debug', true);
      
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
  socket.on('leave_activity', async ({ activityId, userId, userName }) => {
    if (!userId) return;
    
    console.log(`User ${userName || userId} left activity ${activityId}`);
    
    // Update connections map
    const connection = connections.get(socket.id);
    if (connection) {
      connection.activityIds.delete(activityId);
    }
    
    // Remove user from activity participants in memory
    if (activities.has(activityId)) {
      activities.get(activityId).delete(userId);
      
      // Clean up empty activities
      if (activities.get(activityId).size === 0) {
        activities.delete(activityId);
      }
    }
    
    // Leave socket.io room
    socket.leave(activityId);
    
    // Use atomic update to avoid concurrency issues
    try {
      // Update MongoDB directly using updateOne for atomic operation
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
      
      console.log(`Updated participant ${userId} connection status in activity ${activityId}, modified: ${result.modifiedCount}`);
    } catch (error) {
      console.error(`Error updating participant connection status for ${userId} in activity ${activityId}:`, error);
    }
    
    // Get fresh activity data after update and send to clients
    try {
      // Get all participants from database to ensure we include disconnected users
      const activity = await Activity.findOne({ id: activityId });
      if (activity) {
        // Create a map of connected users from the activities map
        const connectedUsers = new Set();
        if (activities.has(activityId)) {
          activities.get(activityId).forEach(id => connectedUsers.add(id));
        }
        
        // Create a list of all participants with correct connection status
        const fullParticipantsList = activity.participants.map(p => {
          // Ensure every participant has a name
          const name = p.name || p.userName || `User-${p.id.substring(0, 6)}`;
          
          return {
            id: p.id,
            name,
            isConnected: connectedUsers.has(p.id)
          };
        });
        
        // Log the participants list for debugging
        console.log(`Participant list for activity ${activityId} after user ${userId} left:`, 
          fullParticipantsList.map(p => `${p.name} (${p.id}): ${p.isConnected ? 'connected' : 'disconnected'}`));
        
        io.to(activityId).emit('participants_updated', {
          activityId,
          participants: fullParticipantsList
        });
        
        console.log(`Sent updated participants list with ${fullParticipantsList.length} users for activity ${activityId}`);
      } else {
        // Fall back to in-memory list if DB query fails
        if (activities.has(activityId)) {
          const participants = Array.from(activities.get(activityId)).map(id => ({
            id,
            name: id === userId ? (userName || `User-${id.substring(0, 6)}`) : `User-${id.substring(0, 6)}`,
            isConnected: true,
          }));
          
          io.to(activityId).emit('participants_updated', {
            activityId,
            participants
          });
        }
      }
    } catch (error) {
      console.error(`Error sending participants list after user ${userId} left activity ${activityId}:`, error);
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
    console.log(`User disconnected: ${socket.id}`);
    
    const connection = connections.get(socket.id);
    if (connection) {
      // For each activity this user was in
      for (const activityId of connection.activityIds) {
        if (activities.has(activityId)) {
          // Remove user from activity in memory
          activities.get(activityId).delete(connection.userId);
          
          // Update the MongoDB database to set isConnected = false for this user
          try {
            const activity = await Activity.findOne({ id: activityId });
            if (activity) {
              const participant = activity.participants.find(p => p.id === connection.userId);
              if (participant) {
                participant.isConnected = false;
                activity.updatedAt = new Date();
                await activity.save();
                console.log(`Updated participant ${connection.userId} to isConnected=false in activity ${activityId} after disconnect`);
              }
            }
          } catch (error) {
            console.error(`Error updating participant connection status for ${connection.userId} in activity ${activityId}:`, error);
          }
          
          // Create full participants list including disconnected users
          try {
            // Get all participants from database to ensure we include disconnected users
            const activity = await Activity.findOne({ id: activityId });
            if (activity) {
              // Create a list of all participants with correct connection status
              const fullParticipantsList = activity.participants.map(p => ({
                id: p.id,
                name: p.name,
                isConnected: p.id === connection.userId ? false : 
                    activities.has(activityId) && activities.get(activityId).has(p.id)
              }));
              
              io.to(activityId).emit('participants_updated', {
                activityId,
                participants: fullParticipantsList
              });
              
              console.log(`Sent updated participants list with ${fullParticipantsList.length} users for activity ${activityId} after disconnect`);
            } else {
              // Fall back to in-memory list if DB query fails
              if (activities.has(activityId)) {
                const participants = Array.from(activities.get(activityId)).map(id => ({
                  id,
                  isConnected: true,
                }));
                
                io.to(activityId).emit('participants_updated', {
                  activityId,
                  participants
                });
              }
            }
          } catch (error) {
            console.error(`Error sending participants list after user ${connection.userId} disconnected from activity ${activityId}:`, error);
          }
          
          // Clean up empty activities
          if (activities.get(activityId).size === 0) {
            activities.delete(activityId);
          }
        }
      }
      
      // Remove connection
      connections.delete(socket.id);
    }
  });
});

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
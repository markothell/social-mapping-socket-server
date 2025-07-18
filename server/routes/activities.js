// server/routes/activities.js
const express = require('express');
const router = express.Router();
const Activity = require('../models/Activity');
const { v4: uuidv4 } = require('uuid');

// Get all activities
router.get('/', async (req, res) => {
  try {
    const activities = await Activity.find();
    res.json(activities);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get single activity
router.get('/:id', async (req, res) => {
  try {
    console.log(`Server: Fetching activity with ID: ${req.params.id}`);
    const activity = await Activity.findOne({ id: req.params.id });
    
    if (!activity) {
      console.log(`Server: Activity ${req.params.id} not found`);
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    console.log(`Server: Found activity ${req.params.id}`);
    res.json(activity);
  } catch (err) {
    console.error(`Server: Error fetching activity ${req.params.id}:`, err);
    res.status(500).json({ message: err.message });
  }
});

// POST route - create new activity
router.post('/', async (req, res) => {
  try {
    console.log('Creating activity with data:', JSON.stringify(req.body, null, 2).substring(0, 500) + '...');
    console.log('Activity ID:', req.body.id);
    console.log('Activity type:', req.body.type);
    
    // Validate required fields
    if (!req.body.type) {
      return res.status(400).json({ 
        message: 'Activity type is required',
        details: 'The activity must have a type property (mapping or ranking)'
      });
    }
    
    // Check if ID already exists
    if (req.body.id) {
      try {
        const existingActivity = await Activity.findOne({ id: req.body.id });
        if (existingActivity) {
          console.log(`Activity with ID ${req.body.id} already exists, returning existing activity`);
          return res.status(200).json(existingActivity); // Return existing instead of error
        }
      } catch (findError) {
        console.error('Error checking for existing activity:', findError);
      }
    }
    
    // Create new Activity instance
    const activity = new Activity({
      ...req.body,
      id: req.body.id || uuidv4().substring(0, 8),
      createdAt: new Date(),
      updatedAt: new Date()
    });
    
    try {
      const newActivity = await activity.save();
      console.log('Activity created successfully:', newActivity.id);
      res.status(201).json(newActivity);
    } catch (validationError) {
      console.error('Validation error creating activity:', validationError);
      
      // More detailed error response
      let errorDetails = 'Unknown validation error';
      let errorFields = {};
      
      if (validationError.message) {
        errorDetails = validationError.message;
      }
      
      if (validationError.errors) {
        errorFields = Object.keys(validationError.errors).reduce((acc, key) => {
          acc[key] = validationError.errors[key].message;
          return acc;
        }, {});
      }
      
      return res.status(400).json({ 
        message: 'Validation error',
        details: errorDetails,
        errors: errorFields
      });
    }
  } catch (err) {
    console.error('Server error creating activity:', err);
    res.status(500).json({ message: err.message || 'Unknown server error' });
  }
});

// Update activity with improved concurrency handling
router.patch('/:id', async (req, res) => {
  try {
    console.log(`Updating activity ${req.params.id} with:`, JSON.stringify(req.body, null, 2));
    
    // First try to find the activity
    const activity = await Activity.findOne({ id: req.params.id });
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    // Check for duplicate participants and combine them
    if (req.body.participants) {
      // Create a map of unique participants by ID
      const participantsMap = new Map();
      
      // First add existing participants that aren't in the update
      activity.participants.forEach(existingParticipant => {
        const ep = existingParticipant.toObject ? existingParticipant.toObject() : existingParticipant;
        if (!req.body.participants.some(p => p.id === ep.id)) {
          participantsMap.set(ep.id, ep);
        }
      });
      
      // Then add/update with the incoming participants
      req.body.participants.forEach(incomingParticipant => {
        // Look for existing participant in the activity
        const existingParticipant = activity.participants.find(p => p.id === incomingParticipant.id);
        
        if (existingParticipant) {
          // Merge properties, with incoming properties taking precedence
          const ep = existingParticipant.toObject ? existingParticipant.toObject() : existingParticipant;
          participantsMap.set(incomingParticipant.id, {
            ...ep,
            ...incomingParticipant,
            // Ensure name exists
            name: incomingParticipant.name || ep.name || `User-${incomingParticipant.id.substring(0, 6)}`
          });
        } else {
          // Add new participant
          participantsMap.set(incomingParticipant.id, {
            ...incomingParticipant,
            // Ensure name exists
            name: incomingParticipant.name || `User-${incomingParticipant.id.substring(0, 6)}`
          });
        }
      });
      
      // Replace the participants array with our de-duplicated version
      req.body.participants = Array.from(participantsMap.values());
      console.log(`De-duplicated participants for ${req.params.id}: ${req.body.participants.length} participants`);
    }
    
    // Update fields directly using the updateOne method for atomic updates
    // This avoids the optimistic concurrency control issues
    try {
      const updateFields = { ...req.body, updatedAt: new Date() };
      console.log(`Server: Update fields being set:`, JSON.stringify(updateFields, null, 2));
      
      const result = await Activity.updateOne(
        { id: req.params.id },
        { $set: updateFields }
      );
      
      console.log(`Server: Update result:`, result);
      
      if (result.modifiedCount === 0) {
        console.warn(`No documents were modified when updating activity ${req.params.id}`);
      }
      
      // Fetch the updated activity
      const updatedActivity = await Activity.findOne({ id: req.params.id });
      if (!updatedActivity) {
        return res.status(404).json({ message: 'Activity not found after update' });
      }
      
      console.log(`Successfully updated activity ${req.params.id}`);
      res.json(updatedActivity);
    } catch (validationError) {
      console.error(`Validation error updating activity ${req.params.id}:`, validationError);
      res.status(400).json({ 
        message: 'Validation error', 
        details: validationError.message || 'Unknown validation error',
        errors: validationError.errors || {}
      });
    }
  } catch (err) {
    console.error(`Error updating activity ${req.params.id}:`, err);
    res.status(500).json({ 
      message: err.message || 'Unknown server error',
      stack: err.stack || 'No stack trace',
      requestBody: req.body
    });
  }
});

// DELETE route - delete activity
router.delete('/:id', async (req, res) => {
  try {
    console.log(`Deleting activity with ID: ${req.params.id}`);
    
    const activity = await Activity.findOne({ id: req.params.id });
    if (!activity) {
      console.log(`Activity ${req.params.id} not found for deletion`);
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    // Use deleteOne instead of remove (which is deprecated)
    const result = await Activity.deleteOne({ id: req.params.id });
    console.log(`Delete result for activity ${req.params.id}:`, result);
    
    if (result.deletedCount === 0) {
      return res.status(500).json({ message: 'Failed to delete activity' });
    }
    
    console.log(`Successfully deleted activity ${req.params.id}`);
    res.json({ 
      message: 'Activity deleted',
      activityId: req.params.id,
      success: true
    });
  } catch (err) {
    console.error(`Error deleting activity ${req.params.id}:`, err);
    res.status(500).json({ message: err.message || 'Unknown server error' });
  }
});

// Add participant to activity
router.post('/:id/participants', async (req, res) => {
  try {
    const activity = await Activity.findOne({ id: req.params.id });
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    // Check if participant already exists
    const existingParticipant = activity.participants.find(p => p.id === req.body.id);
    if (existingParticipant) {
      existingParticipant.isConnected = true;
    } else {
      activity.participants.push(req.body);
    }
    
    activity.updatedAt = new Date();
    const updatedActivity = await activity.save();
    res.json(updatedActivity);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Update participant
router.patch('/:id', async (req, res) => {
  try {
    console.log(`Updating activity ${req.params.id} with:`, JSON.stringify(req.body, null, 2));
    
    const activity = await Activity.findOne({ id: req.params.id });
    if (!activity) {
      console.log(`Activity ${req.params.id} not found for update`);
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    // Update only provided fields
    Object.keys(req.body).forEach(key => {
      activity[key] = req.body[key];
    });
    
    activity.updatedAt = new Date();
    
    try {
      const updatedActivity = await activity.save();
      console.log(`Successfully updated activity ${req.params.id}`);
      res.json(updatedActivity);
    } catch (validationError) {
      console.error(`Validation error updating activity ${req.params.id}:`, validationError);
      res.status(400).json({ 
        message: 'Validation error', 
        details: validationError.message || 'Unknown validation error',
        errors: validationError.errors || {}
      });
    }
  } catch (err) {
    console.error(`Error updating activity ${req.params.id}:`, err);
    res.status(500).json({ message: err.message || 'Unknown server error' });
  }
});

// Remove participant
router.delete('/:id/participants/:participantId', async (req, res) => {
  try {
    const activity = await Activity.findOne({ id: req.params.id });
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    activity.participants = activity.participants.filter(p => p.id !== req.params.participantId);
    activity.updatedAt = new Date();
    const updatedActivity = await activity.save();
    res.json(updatedActivity);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Add tag to activity
router.post('/:id/tags', async (req, res) => {
  try {
    const activity = await Activity.findOne({ id: req.params.id });
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    // Add new tag
    activity.tags.push({
      ...req.body,
      id: req.body.id || uuidv4().substring(0, 8),
      votes: req.body.votes || [],
      comments: req.body.comments || [],
      commentCount: req.body.comments?.length || 0,
      hasNewComments: false,
      status: activity.settings.tagCreation?.enableVoting ? 'pending' : 'approved',
      createdAt: new Date()
    });
    
    activity.updatedAt = new Date();
    const updatedActivity = await activity.save();
    res.json(updatedActivity);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Update tag
router.patch('/:id/tags/:tagId', async (req, res) => {
  try {
    const activity = await Activity.findOne({ id: req.params.id });
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    const tagIndex = activity.tags.findIndex(t => t.id === req.params.tagId);
    if (tagIndex === -1) {
      return res.status(404).json({ message: 'Tag not found' });
    }
    
    // Update tag fields
    Object.keys(req.body).forEach(key => {
      activity.tags[tagIndex][key] = req.body[key];
    });
    
    activity.updatedAt = new Date();
    const updatedActivity = await activity.save();
    res.json(updatedActivity);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete tag
router.delete('/:id/tags/:tagId', async (req, res) => {
  try {
    const activity = await Activity.findOne({ id: req.params.id });
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    activity.tags = activity.tags.filter(t => t.id !== req.params.tagId);
    activity.updatedAt = new Date();
    const updatedActivity = await activity.save();
    res.json(updatedActivity);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update mappings for a user
router.put('/:id/mappings/:userId', async (req, res) => {
  try {
    const activity = await Activity.findOne({ id: req.params.id });
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    // Find existing mapping or create new one
    let userMapping = activity.mappings.find(m => m.userId === req.params.userId);
    
    if (userMapping) {
      userMapping.positions = req.body.positions;
    } else {
      // Get user name from participants
      const participant = activity.participants.find(p => p.id === req.params.userId);
      const userName = participant ? participant.name : 'Unknown';
      
      activity.mappings.push({
        userId: req.params.userId,
        userName,
        positions: req.body.positions,
        isComplete: false
      });
    }
    
    activity.updatedAt = new Date();
    const updatedActivity = await activity.save();
    res.json(updatedActivity);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Complete mappings for a user
router.patch('/:id/mappings/:userId/complete', async (req, res) => {
  try {
    const activity = await Activity.findOne({ id: req.params.id });
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    // Find user's mapping
    const mappingIndex = activity.mappings.findIndex(m => m.userId === req.params.userId);
    if (mappingIndex === -1) {
      return res.status(404).json({ message: 'Mapping not found' });
    }
    
    activity.mappings[mappingIndex].isComplete = true;
    activity.updatedAt = new Date();
    const updatedActivity = await activity.save();
    res.json(updatedActivity);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Change activity phase
router.patch('/:id/phase', async (req, res) => {
  try {
    const activity = await Activity.findOne({ id: req.params.id });
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    if (!req.body.phase) {
      return res.status(400).json({ message: 'Phase is required' });
    }
    
    activity.phase = req.body.phase;
    activity.updatedAt = new Date();
    const updatedActivity = await activity.save();
    res.json(updatedActivity);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Complete activity
router.patch('/:id/complete', async (req, res) => {
  try {
    const activity = await Activity.findOne({ id: req.params.id });
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    activity.status = 'completed';
    activity.updatedAt = new Date();
    const updatedActivity = await activity.save();
    res.json(updatedActivity);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Clone activity with lineage tracking
router.post('/:id/clone', async (req, res) => {
  try {
    console.log(`Cloning activity ${req.params.id}`);
    
    const originalActivity = await Activity.findOne({ id: req.params.id });
    if (!originalActivity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 7);
    const newId = `${timestamp}_${random}`;
    
    const clonedActivity = new Activity({
      ...originalActivity.toObject(),
      _id: undefined,
      id: newId,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'active',
      phase: 'gathering',
      participants: [],
      tags: [],
      mappings: [],
      rankings: [],
      lineage: [...(originalActivity.lineage || []), originalActivity.id],
      children: [],
      clonedFrom: originalActivity.id,
      settings: {
        ...originalActivity.settings,
        entryView: {
          ...originalActivity.settings.entryView,
          title: `${originalActivity.settings.entryView?.title || 'Untitled'} (Clone)`
        }
      }
    });
    
    const savedClone = await clonedActivity.save();
    console.log(`Created clone with ID: ${newId}`);
    
    // Update parent to include this child
    await Activity.updateOne(
      { id: req.params.id },
      { 
        $push: { children: newId },
        $set: { updatedAt: new Date() }
      }
    );
    
    console.log(`Successfully cloned activity ${req.params.id} as ${newId}`);
    res.status(201).json(savedClone);
  } catch (err) {
    console.error(`Error cloning activity ${req.params.id}:`, err);
    res.status(500).json({ message: err.message });  
  }
});

// Load data into activity
router.post('/:id/load-data', async (req, res) => {
  try {
    console.log(`Loading data into activity ${req.params.id}`);
    
    const activity = await Activity.findOne({ id: req.params.id });
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    
    const { participants, tags, mappings, phase } = req.body;
    
    // Load participants if provided
    if (participants) {
      // Merge participants, avoiding duplicates
      const existingParticipantIds = new Set(activity.participants.map(p => p.id));
      const newParticipants = participants.filter(p => !existingParticipantIds.has(p.id));
      activity.participants.push(...newParticipants);
      console.log(`Added ${newParticipants.length} new participants`);
    }
    
    // Load tags if provided
    if (tags) {
      // Merge tags, avoiding duplicates
      const existingTagIds = new Set(activity.tags.map(t => t.id));
      const newTags = tags.filter(t => !existingTagIds.has(t.id));
      activity.tags.push(...newTags);
      console.log(`Added ${newTags.length} new tags`);
    }
    
    // Load mappings if provided
    if (mappings) {
      // Merge mappings, replacing existing ones for the same user
      mappings.forEach(newMapping => {
        const existingMappingIndex = activity.mappings.findIndex(m => m.userId === newMapping.userId);
        if (existingMappingIndex !== -1) {
          activity.mappings[existingMappingIndex] = newMapping;
        } else {
          activity.mappings.push(newMapping);
        }
      });
      console.log(`Loaded ${mappings.length} mappings`);
    }
    
    // Update phase if provided
    if (phase) {
      activity.phase = phase;
      console.log(`Set phase to ${phase}`);
    }
    
    activity.updatedAt = new Date();
    const updatedActivity = await activity.save();
    
    console.log(`Successfully loaded data into activity ${req.params.id}`);
    res.json({
      message: 'Data loaded successfully',
      activity: updatedActivity,
      summary: {
        participantsLoaded: participants?.length || 0,
        tagsLoaded: tags?.length || 0,
        mappingsLoaded: mappings?.length || 0,
        phaseSet: phase || null
      }
    });
  } catch (err) {
    console.error(`Error loading data into activity ${req.params.id}:`, err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
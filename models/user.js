// Load required packages
var mongoose = require('mongoose');

// A user's pendingTasks stores the ids of tasks that are assigned to the user
// and are not yet completed. The route handlers keep it synchronized with Task.
var UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    pendingTasks: { type: [String], default: [] }
}, {
    timestamps: { createdAt: 'dateCreated', updatedAt: false }
});

// Export the Mongoose model
module.exports = mongoose.model('User', UserSchema);

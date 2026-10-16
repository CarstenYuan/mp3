var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');

var UNASSIGNED = 'unassigned';

function send(res, status, message, data) {
    return res.status(status).json({ message: message, data: data });
}
function bad(res, text) { send(res, 400, 'Bad Request', text); return null; }
function missing(res, kind) { return send(res, 404, kind + ' Not Found', kind + ' not found.'); }
function fail(res, error) {
    console.error(error);
    return send(res, 500, 'Internal Server Error', 'An unexpected server error occurred.');
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validId(value) { return typeof value === 'string' && mongoose.isObjectIdOrHexString(value); }

function jsonParameter(req, name, res) {
    if (req.query[name] === undefined) return { present: false };
    try {
        var value = JSON.parse(req.query[name]);
        if (!object(value)) throw new Error('Expected an object');
        return { present: true, value: value };
    } catch (error) {
        bad(res, 'Invalid JSON for query parameter "' + name + '".');
        return null;
    }
}
function collectionQuery(req, res, isTask) {
    var where = jsonParameter(req, 'where', res);
    if (!where) return null;
    var sort = jsonParameter(req, 'sort', res);
    if (!sort) return null;
    var select = jsonParameter(req, 'select', res);
    if (!select) return null;
    function integer(name, fallback) {
        if (req.query[name] === undefined) return fallback;
        return /^\d+$/.test(req.query[name]) ? Number(req.query[name]) : 'invalid';
    }
    var skip = integer('skip', 0);
    // Tasks default to 100 results; users are unlimited unless limit is supplied.
    var limit = integer('limit', isTask ? 100 : undefined);
    if (skip === 'invalid' || limit === 'invalid') return bad(res, 'skip and limit must be non-negative integers.');
    if (req.query.count !== undefined && !['true', 'false'].includes(req.query.count)) {
        return bad(res, 'count must be true or false.');
    }
    return {
        where: where.present ? where.value : {}, sort: sort.present ? sort.value : null,
        select: select.present ? select.value : null, skip: skip, limit: limit,
        count: req.query.count === 'true'
    };
}

function userInput(body, res) {
    if (!object(body) || typeof body.name !== 'string' || typeof body.email !== 'string') {
        return bad(res, 'name and email are required strings.');
    }
    var ids = body.pendingTasks === undefined ? [] : body.pendingTasks;
    if (!Array.isArray(ids) || !ids.every(validId)) return bad(res, 'pendingTasks must be an array of valid task ids.');
    if (new Set(ids).size !== ids.length) return bad(res, 'pendingTasks cannot contain duplicate task ids.');
    return { name: body.name, email: body.email, pendingTasks: ids };
}
function dateValue(value) {
    return (typeof value === 'string' || value instanceof Date) && !Number.isNaN(new Date(value).getTime());
}
function taskInput(body, res) {
    if (!object(body) || typeof body.name !== 'string' || !dateValue(body.deadline)) {
        return bad(res, 'name and deadline are required and must have valid types.');
    }
    if (body.description !== undefined && typeof body.description !== 'string') return bad(res, 'description must be a string.');
    if (body.completed !== undefined && typeof body.completed !== 'boolean') return bad(res, 'completed must be a boolean.');
    var assignedUser = body.assignedUser === undefined ? '' : body.assignedUser;
    if (typeof assignedUser !== 'string' || (assignedUser && !validId(assignedUser))) {
        return bad(res, 'assignedUser must be empty or a valid user id.');
    }
    if (body.assignedUserName !== undefined && typeof body.assignedUserName !== 'string') return bad(res, 'assignedUserName must be a string.');
    if (!assignedUser && body.assignedUserName !== undefined && body.assignedUserName !== UNASSIGNED) {
        return bad(res, 'An unassigned task must use assignedUserName "unassigned".');
    }
    return {
        name: body.name, description: body.description === undefined ? '' : body.description,
        deadline: new Date(body.deadline), completed: body.completed === undefined ? false : body.completed,
        assignedUser: assignedUser, assignedUserName: body.assignedUserName
    };
}

async function requestedTasks(ids, session) {
    if (!ids.length) return [];
    return Task.find({ _id: { $in: ids } }).session(session);
}
async function removePending(userId, taskId, session) {
    if (userId) await User.updateOne({ _id: userId }, { $pull: { pendingTasks: taskId } }).session(session);
}
async function saveUserAndReferences(user, input, session) {
    var oldIds = user.pendingTasks.map(String);
    var newSet = new Set(input.pendingTasks);
    for (var oldId of oldIds) {
        if (!newSet.has(oldId)) {
            await Task.updateOne({ _id: oldId }, { $set: { assignedUser: '', assignedUserName: UNASSIGNED } }).session(session);
        }
    }
    var tasks = await requestedTasks(input.pendingTasks, session);
    for (var task of tasks) {
        if (task.assignedUser && task.assignedUser !== String(user._id)) {
            await removePending(task.assignedUser, String(task._id), session);
        }
        // New task assignments, moves, and name changes all converge here.
        task.assignedUser = String(user._id);
        task.assignedUserName = input.name;
        await task.save({ session: session });
    }
    // A rename affects completed tasks too, even though they are not pending.
    if (user.name !== input.name) {
        await Task.updateMany({ assignedUser: String(user._id) }, { $set: { assignedUserName: input.name } }).session(session);
    }
    user.name = input.name;
    user.email = input.email;
    user.pendingTasks = input.pendingTasks;
    await user.save({ session: session });
}
async function saveTaskAndReference(task, input, user, session) {
    var id = String(task._id);
    if (task.assignedUser && task.assignedUser !== input.assignedUser) {
        await removePending(task.assignedUser, id, session);
    }
    if (task.assignedUser && input.completed) await removePending(task.assignedUser, id, session);
    task.name = input.name;
    task.description = input.description;
    task.deadline = input.deadline;
    task.completed = input.completed;
    task.assignedUser = input.assignedUser;
    task.assignedUserName = input.assignedUser ? user.name : UNASSIGNED;
    await task.save({ session: session });
    if (input.assignedUser && !input.completed) {
        await User.updateOne({ _id: input.assignedUser }, { $addToSet: { pendingTasks: id } }).session(session);
    }
}

function getCollection(router, path, Model, isTask) {
    router.get('/' + path, async function (req, res) {
        var options = collectionQuery(req, res, isTask);
        if (!options) return;
        try {
            if (options.count) return send(res, 200, 'OK', await Model.countDocuments(options.where));
            var query = Model.find(options.where).skip(options.skip);
            if (options.sort) query.sort(options.sort);
            if (options.select) query.select(options.select);
            if (options.limit !== null) query.limit(options.limit);
            return send(res, 200, 'OK', await query);
        } catch (error) { return fail(res, error); }
    });
}

module.exports = function (router) {
    getCollection(router, 'users', User, false);
    getCollection(router, 'tasks', Task, true);

    router.post('/users', async function (req, res) {
        var input = userInput(req.body, res);
        if (!input) return;
        var session = await mongoose.startSession();
        try {
            var created;
            await session.withTransaction(async function () {
                if (await User.exists({ email: input.email }).session(session)) throw { type: 'email' };
                var tasks = await requestedTasks(input.pendingTasks, session);
                if (tasks.length !== input.pendingTasks.length) throw { type: 'task404' };
                if (tasks.some(function (task) { return task.completed; })) throw { type: 'completed' };
                created = new User(input);
                await created.save({ session: session });
                await saveUserAndReferences(created, input, session);
            });
            return send(res, 201, 'Created', created);
        } catch (error) {
            if (error.type === 'email' || error.code === 11000) return bad(res, 'Email is already in use.');
            if (error.type === 'task404') return missing(res, 'Task');
            if (error.type === 'completed') return bad(res, 'Completed tasks cannot be in pendingTasks.');
            return fail(res, error);
        } finally { await session.endSession(); }
    });

    router.get('/users/:id', async function (req, res) {
        if (!validId(req.params.id)) return missing(res, 'User');
        var select = jsonParameter(req, 'select', res);
        if (!select) return;
        try {
            var query = User.findById(req.params.id);
            if (select.present) query.select(select.value);
            var user = await query;
            return user ? send(res, 200, 'OK', user) : missing(res, 'User');
        } catch (error) { return fail(res, error); }
    });
    router.put('/users/:id', async function (req, res) {
        if (!validId(req.params.id)) return missing(res, 'User');
        var input = userInput(req.body, res);
        if (!input) return;
        var session = await mongoose.startSession();
        try {
            var user;
            await session.withTransaction(async function () {
                user = await User.findById(req.params.id).session(session);
                if (!user) throw { type: 'user404' };
                if (await User.exists({ email: input.email, _id: { $ne: user._id } }).session(session)) throw { type: 'email' };
                var tasks = await requestedTasks(input.pendingTasks, session);
                if (tasks.length !== input.pendingTasks.length) throw { type: 'task404' };
                if (tasks.some(function (task) { return task.completed; })) throw { type: 'completed' };
                await saveUserAndReferences(user, input, session);
            });
            return send(res, 200, 'OK', user);
        } catch (error) {
            if (error.type === 'user404') return missing(res, 'User');
            if (error.type === 'email' || error.code === 11000) return bad(res, 'Email is already in use.');
            if (error.type === 'task404') return missing(res, 'Task');
            if (error.type === 'completed') return bad(res, 'Completed tasks cannot be in pendingTasks.');
            return fail(res, error);
        } finally { await session.endSession(); }
    });
    router.delete('/users/:id', async function (req, res) {
        if (!validId(req.params.id)) return missing(res, 'User');
        var session = await mongoose.startSession();
        try {
            var found = false;
            await session.withTransaction(async function () {
                var user = await User.findById(req.params.id).session(session);
                if (!user) return;
                found = true;
                await Task.updateMany({ assignedUser: String(user._id) }, { $set: { assignedUser: '', assignedUserName: UNASSIGNED } }).session(session);
                await user.deleteOne({ session: session });
            });
            return found ? res.status(204).send() : missing(res, 'User');
        } catch (error) { return fail(res, error); } finally { await session.endSession(); }
    });

    router.post('/tasks', async function (req, res) {
        var input = taskInput(req.body, res);
        if (!input) return;
        var session = await mongoose.startSession();
        try {
            var created;
            await session.withTransaction(async function () {
                var user = null;
                if (input.assignedUser) {
                    user = await User.findById(input.assignedUser).session(session);
                    if (!user) throw { type: 'user404' };
                    if (input.assignedUserName !== undefined && input.assignedUserName !== user.name) throw { type: 'wrongName' };
                }
                created = new Task(input);
                await created.save({ session: session });
                await saveTaskAndReference(created, input, user, session);
            });
            return send(res, 201, 'Created', created);
        } catch (error) {
            if (error.type === 'user404') return missing(res, 'User');
            if (error.type === 'wrongName') return bad(res, 'assignedUserName must match the assigned user.');
            return fail(res, error);
        } finally { await session.endSession(); }
    });

    router.get('/tasks/:id', async function (req, res) {
        if (!validId(req.params.id)) return missing(res, 'Task');
        var select = jsonParameter(req, 'select', res);
        if (!select) return;
        try {
            var query = Task.findById(req.params.id);
            if (select.present) query.select(select.value);
            var task = await query;
            return task ? send(res, 200, 'OK', task) : missing(res, 'Task');
        } catch (error) { return fail(res, error); }
    });
    router.put('/tasks/:id', async function (req, res) {
        if (!validId(req.params.id)) return missing(res, 'Task');
        var input = taskInput(req.body, res);
        if (!input) return;
        var session = await mongoose.startSession();
        try {
            var task;
            await session.withTransaction(async function () {
                task = await Task.findById(req.params.id).session(session);
                if (!task) throw { type: 'task404' };
                var user = null;
                if (input.assignedUser) {
                    user = await User.findById(input.assignedUser).session(session);
                    if (!user) throw { type: 'user404' };
                    if (input.assignedUserName !== undefined && input.assignedUserName !== user.name) throw { type: 'wrongName' };
                }
                await saveTaskAndReference(task, input, user, session);
            });
            return send(res, 200, 'OK', task);
        } catch (error) {
            if (error.type === 'task404') return missing(res, 'Task');
            if (error.type === 'user404') return missing(res, 'User');
            if (error.type === 'wrongName') return bad(res, 'assignedUserName must match the assigned user.');
            return fail(res, error);
        } finally { await session.endSession(); }
    });
    router.delete('/tasks/:id', async function (req, res) {
        if (!validId(req.params.id)) return missing(res, 'Task');
        var session = await mongoose.startSession();
        try {
            var found = false;
            await session.withTransaction(async function () {
                var task = await Task.findById(req.params.id).session(session);
                if (!task) return;
                found = true;
                await removePending(task.assignedUser, String(task._id), session);
                await task.deleteOne({ session: session });
            });
            return found ? res.status(204).send() : missing(res, 'Task');
        } catch (error) { return fail(res, error); } finally { await session.endSession(); }
    });
    return router;
};

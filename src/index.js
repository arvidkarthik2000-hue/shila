'use strict';
// Loads the bundled data and returns a ready SHILA instance.
const { createShila } = require('./core.js');
const models = require('../data/models.json');
const hardware = require('../data/hardware.json');
const meta = require('../data/meta.json');
module.exports = createShila({ models, hardware, meta });
module.exports.createShila = createShila;

"use strict";

var plugin = require("./plugin");
var commands = require("./commands");

module.exports = {
  setupPtkCypress: plugin.setupPtkCypress,
  ptkPlugin: plugin.ptkPlugin,
  registerCommands: commands.registerCommands,
};

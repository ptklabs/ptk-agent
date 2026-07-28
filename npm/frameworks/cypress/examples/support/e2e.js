"use strict";

const path = require("path");
const packageRoot = process.env.PTK_PACKAGE_ROOT;
const { registerCommands } = process.env.PTK_RELEASE_TEST_MODE === "package" && packageRoot
  ? require(path.join(packageRoot, "frameworks", "cypress", "index.cjs"))
  : require("../..");

registerCommands();

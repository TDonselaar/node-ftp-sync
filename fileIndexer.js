"use strict";

const fs = require("fs");
const { readdir } = require("fs").promises;
const pathLib = require("path");
const ftpcore = require("qusly-core");
const level = require("level");

var FileIndexer = function () {
  this.options = {
    dir: null,
    databaseName: null,
  };
  this.db = null;
  this.changeList = [];
  this.dirList = [];
  this.totalFileSize = 0;
  this.fileErrors = [];
  this.endFileList = [];
  this.pushToEnd = [];

  this.stats = {
    files: 0,
    size: 0
  };
  this.excludeDirs = [];
};

FileIndexer.prototype.reset = function (dir) {
  this.changeList = [];
  this.dirList = [];
  this.endFileList = [];
  this.pushToEnd = [];
  this.totalFileSize = 0;
  this.stats = {
    files: 0,
    size: 0
  };
  this.closeDb();
};

FileIndexer.prototype.skipFile = function (file) {
  for (let i = 0; i < this.endFileList.length; i++) {
    if (this.endFileList[i] == file) {
      return true;
    }
  }

  return false;
}

FileIndexer.prototype.isExcluded = function (dir) {
  for (let i = 0; i < this.excludeDirs.length; i++) {
    if (this.excludeDirs[i].path == dir) {
      return true;
    }
  }

  return false;
}

FileIndexer.prototype.setEndFileList = function (files) {
  this.endFileList = files;
};

FileIndexer.prototype.setExcludedDirs = function (dirs) {
  this.excludeDirs = dirs;
};

FileIndexer.prototype.setDir = function (dir) {
  this.options.dir = dir;
};

FileIndexer.prototype.setDatabase = function (databaseName) {
  this.options.databaseName = databaseName;
};

FileIndexer.prototype.initDb = async function () {
  return new Promise((resolve, reject) => {
    if (this.db == null) {
      this.db = level(this.options.databaseName, {}, (err, db) => {
        if (err) throw err
        resolve();
      });
    } else {
      resolve();
    }
  });
};

FileIndexer.prototype.closeDb = function (name) {
  if (this.db !== null) {
    this.db.close();
    this.db = null;
  }
};

FileIndexer.prototype.scan = async function (dir) {
  if (this.options.databaseName === null || this.options.dir === null) {
    throw "Options not set";
  }
  await this.initDb();
  await this.readDir(this.options.dir);
  await this.closeDb();
};

FileIndexer.prototype.updateStats = function (file, stats) {
  if (this.db === null) {
    throw "Database is not open";
  }
  return this.db.put(file, JSON.stringify(stats));
};

FileIndexer.prototype.isChanged = function (file, stats) {
  if (this.db === null) {
    throw "Database is not open";
  }
  return new Promise((resolve, reject) => {
    this.db.get(file, (err, value) => {
      this.stats.files++;
      this.stats.size += stats.size;
      if (err) {
        this.totalFileSize += stats.size;
        if (this.skipFile(file)) {
          this.pushToEnd.push({ fullpath: file, stats: stats, baseDir: this.options.dir });
        } else {
          this.changeList.push({ fullpath: file, stats: stats, baseDir: this.options.dir });
        }
        resolve();
        return;
      }
      value = JSON.parse(value);
      if (value.mtimeMs != stats.mtimeMs) {
        this.totalFileSize += stats.size;
        if (this.skipFile(file)) {
          this.pushToEnd.push({ fullpath: file, stats: stats, baseDir: this.options.dir });
        } else {
          this.changeList.push({ fullpath: file, stats: stats, baseDir: this.options.dir });
        }
      }
      resolve();
    });
  });
};

FileIndexer.prototype.hasAccess = function (file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch (err) {
    return false;
  }
}

FileIndexer.prototype.readDir = async function (dir) {
  let items = [];
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    return false;
  }
  let fullpath = null;
  let stats = null;
  for (let index = 0; index < items.length; index++) {
    if (!items[index].name) { continue; }
    fullpath = pathLib.join(dir, items[index].name);
    if (!this.hasAccess(fullpath)) {
      this.fileErrors.push(fullpath);
      continue;
    }
    try {
      stats = fs.lstatSync(fullpath);
    } catch (error) {
      this.fileErrors.push(fullpath);
      continue;
    }

    if (stats.isDirectory()) {
      if (this.isExcluded(fullpath)) { continue; }
      this.dirList.push({ dir: fullpath });
      await this.readDir(fullpath);
    } else if (stats.isFile()) {
      await this.isChanged(fullpath, stats);
    }
  }

  for (let index2 = 0; index2 < this.pushToEnd.length; index2++) {
    this.changeList.push(this.pushToEnd[index2]);
  }
};

module.exports = FileIndexer;

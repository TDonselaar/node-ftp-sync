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

  this.stats = {
    files: 0,
    size: 0
  };
};

FileIndexer.prototype.reset = function (dir) {
  this.changeList = [];
  this.dirList = [];
  this.totalFileSize = 0;
  this.stats = {
    files: 0,
    size: 0
  };
  this.closeDb();
};

FileIndexer.prototype.setDir = function (dir) {
  this.options.dir = dir;
};

FileIndexer.prototype.setDatabase = function (databaseName) {
  this.options.databaseName = databaseName;
};

FileIndexer.prototype.initDb = function (name) {
  if (this.db == null) this.db = level(this.options.databaseName);
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
  this.initDb();
  await this.readDir(this.options.dir);
  this.closeDb();
};

FileIndexer.prototype.updateStats = async function (file, stats) {
  if (this.db === null) {
    throw "Database is not open";
  }
  await this.db.put(file, JSON.stringify(stats));
};

FileIndexer.prototype.isChanged = async function (file, stats) {
  if (this.db === null) {
    throw "Database is not open";
  }
  await this.db.get(file, (err, value) => {
    this.stats.files++;
    this.stats.size += stats.size;
    if (err) {
      this.totalFileSize += stats.size;
      this.changeList.push({ fullpath: file, stats: stats });
      return;
    }
    value = JSON.parse(value);
    if (value.atimeMs != stats.atimeMs) {
      this.totalFileSize += stats.size;
      this.changeList.push({ fullpath: file, stats: stats });
    }
  });
};

FileIndexer.prototype.readDir = async function (dir) {
  let items = await readdir(dir, { withFileTypes: true });
  for (let index = 0; index < items.length; index++) {
    if(!items[index].name){ continue; }
    let fullpath = pathLib.join(dir, items[index].name);
    let stats = fs.lstatSync(fullpath);
    if (stats.isDirectory()) {
      this.dirList.push({ dir: fullpath });
      await this.readDir(fullpath);
    } else if (stats.isFile()) {
      await this.isChanged(fullpath, stats);
    }
  }
};

module.exports = FileIndexer;

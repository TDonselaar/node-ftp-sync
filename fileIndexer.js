"use strict";

const fs = require("fs");
const { readdir } = require("fs").promises;
const pathLib = require("path");
const ftpcore = require("qusly-core");
const level = require("level");

var FileIndexer = function() {
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
    this.blockFileList = [];
    this.lastCalculatedAt = 0;

    this.stats = {
        files: 0,
        size: 0
    };
    this.excludeDirs = [];
};

FileIndexer.prototype.reset = async function(dir) {
    this.changeList = [];
    this.dirList = [];
    this.endFileList = [];
    this.pushToEnd = [];
    this.blockFileList = [];
    this.totalFileSize = 0;
    this.stats = {
        files: 0,
        size: 0
    };
    await this.closeDb();
};

FileIndexer.prototype.blockedFile = function(file) {
    for (let i = 0; i < this.blockFileList.length; i++) {
        if (this.blockFileList[i] == file) {
            return true;
        }
    }
    return false;
}

FileIndexer.prototype.skipFile = function(file) {
    for (let i = 0; i < this.endFileList.length; i++) {
        if (this.endFileList[i] == file) {
            return true;
        }
    }

    return false;
}

FileIndexer.prototype.isExcluded = function(dir) {
    for (let i = 0; i < this.excludeDirs.length; i++) {
        if (this.excludeDirs[i].path.toLowerCase() == dir.toLowerCase()) {
            return true;
        }
    }

    return false;
}

FileIndexer.prototype.setBlockedFileList = function(files) {
    this.blockFileList = files;
};

FileIndexer.prototype.setEndFileList = function(files) {
    this.endFileList = files;
};

FileIndexer.prototype.setExcludedDirs = function(dirs) {
    this.excludeDirs = dirs;
};

FileIndexer.prototype.setDir = function(dir) {
    this.options.dir = dir;
};

FileIndexer.prototype.setDatabase = function(databaseName) {
    this.options.databaseName = databaseName;
};

FileIndexer.prototype.onAccessError = function(file) {

};

FileIndexer.prototype.claculateFiles = function() {
    if (this.lastCalculatedAt < Date.now()) {
        this.lastCalculatedAt = Date.now() + 1000;
        this.onClaculateFiles(this.stats.files);
    }
};

FileIndexer.prototype.onClaculateFiles = function(amount) {

};

FileIndexer.prototype.initDb = async function() {
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

FileIndexer.prototype.closeDb = async function(name) {
    return new Promise((resolve, reject) => {
        if (this.db !== null) {
            this.db.close((err) => {
                this.db = null;
                resolve();
            });
            return;
        }
        resolve();
    });
};

FileIndexer.prototype.scan = async function(dir) {
    if (this.options.databaseName === null || this.options.dir === null) {
        throw "Options not set";
    }
    await this.initDb();
    await this.readDir(this.options.dir);
    await this.closeDb();
};

FileIndexer.prototype.updateStats = function(file, stats) {
    if (this.db === null) {
        throw "Database is not open";
    }
    return this.db.put(file, JSON.stringify(stats));
};

FileIndexer.prototype.isChanged = function(file, stats) {
    if (this.db === null) {
        throw "Database is not open";
    }
    return new Promise((resolve, reject) => {
        this.db.get(file, (err, value) => {
            //don't add blocked files to index
            if (this.blockedFile(file)) {
                resolve();
                return;
            }
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

FileIndexer.prototype.hasAccess = function(file) {
    try {
        fs.accessSync(file, fs.constants.R_OK);
        return true;
    } catch (err) {
        this.onAccessError(file);
        return false;
    }
}

FileIndexer.prototype.readDir = async function(dir) {
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
            this.claculateFiles();
        } else if (stats.isFile()) {
            await this.isChanged(fullpath, stats);
        }
    }
    this.claculateFiles();
};

FileIndexer.prototype.addAllToEnd = function() {
    for (let index2 = 0; index2 < this.pushToEnd.length; index2++) {
        this.changeList.push(this.pushToEnd[index2]);
    }
    this.claculateFiles();
};

module.exports = FileIndexer;
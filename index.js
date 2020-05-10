"use strict";

const FileIndexer = require("./fileIndexer");

const level = require("level");
const pathLib = require("path");
const fs = require("fs");
const ftp = require("basic-ftp");
const upath = require("upath");

var FtpSync = function ({ username, password, host }) {
  this.options = {
    dir: null,
    databaseName: null,
    username: username,
    password: password,
    host: host
  };
  this.db = null;
  this.fileIndexer = new FileIndexer();
  this.ftpBaseDir = "";
  this.client = new ftp.Client();
  this.status = {};
  this.totalSizeUploaded = 0;
  this.uploadSpeed = 0;
  this.uploadSpeedTime = null;
  this.uploadSpeedLastBytes = 0;
  this.lastUploadSpeed = 0;
  this.stop = false;
  this.ready = true;
  this.dirCreationCache = [];
};

FtpSync.prototype.reset = function () {
  this.fileIndexer.closeDb();
  this.closeDb();
  this.disconnect();
  this.status = {};
  this.totalSizeUploaded = 0;
  this.uploadSpeed = 0;
  this.uploadSpeedTime = null;
  this.uploadSpeedLastBytes = 0;
  this.lastUploadSpeed = 0;
  this.stop = false;
  this.dirCreationCache = [];
};

FtpSync.prototype.check = function () {
  return this.client.access({
    host: this.options.host,
    user: this.options.username,
    password: this.options.password,
    secure: true,
  });
};

FtpSync.prototype.connect = async function () {
  try {
    await this.client.access({
      host: this.options.host,
      user: this.options.username,
      password: this.options.password,
      secure: true,
    });
  } catch (err) {
    this.onConnectError(err);
  }
};

FtpSync.prototype.disconnect = function () {
  this.client.close();
};

FtpSync.prototype.reconnect = async function () {
  await this.connect();
};

FtpSync.prototype.onConnectError = function (err) {
  console.log(err);
  throw err;
};

FtpSync.prototype.onUploadError = function (err) {
  if (err.code === "ECONNRESET") {
    return true;
  }

  if (err.code === "ECONNABORTED") {
    return true;
  }

  if (err.code === 425) {
    return true;
  }
  if (err.message.includes("User closed client during task")) {
    return false;
  }

  console.log(err);
  throw err;
  return false;
};

FtpSync.prototype.setDir = function (dir) {
  this.options.dir = pathLib.normalize(dir);
  if (!fs.existsSync(this.options.dir)) {
    throw "Path does not exist";
  }
  dir = this.options.dir.split(pathLib.sep);
  this.ftpBaseDir = "/home/" + dir.pop();
};

FtpSync.prototype.setDatabase = function (databaseName) {
  this.options.databaseName = databaseName;
};

FtpSync.prototype.initDb = function (name) {
  if (this.db == null) this.db = level(this.options.databaseName);
};

FtpSync.prototype.closeDb = function (name) {
  if (this.db !== null) {
    this.db.close();
    this.db = null;
  }
};

FtpSync.prototype.statusUpdate = function (info) {};

FtpSync.prototype.sync = async function () {
  if (this.options.databaseName === null || this.options.dir === null) {
    throw "Options not set";
  }
  this.fileIndexer.reset();
  this.fileIndexer.setDatabase(this.options.databaseName);
  this.fileIndexer.setDir(this.options.dir);

  await this.fileIndexer.scan();
  await this.connect();
  await this.fileIndexer.initDb();

  this.client.trackProgress((info) => {
    if (this.halt()) {
      return;
    }
    this.statusFtp = info;
    if (this.uploadSpeedTime == null) {
      this.uploadSpeedTime = new Date().getTime();
    }

    let timeDiff = (new Date().getTime() - this.uploadSpeedTime) / 1000;
    this.uploadSpeedTime = new Date().getTime();
    let bytesDiff = info.bytes - this.uploadSpeedLastBytes;
    this.uploadSpeedLastBytes = info.bytesOverall;
    if (bytesDiff > 0) {
      this.lastUploadSpeed = (bytesDiff / timeDiff) * 8;
    }

    this.statusUpdate({
      current: this.status,
      ftp: info,
      basePath: this.ftpBaseDir,
      username: this.options.username,
      totalSize: this.fileIndexer.totalFileSize,
      totalSizeUploaded: this.totalSizeUploaded,
      totalFiles: this.fileIndexer.changeList.length,
      dirFiles: this.fileIndexer.stats.files,
      dirSize: this.fileIndexer.stats.size,
      uploadSpeed: this.lastUploadSpeed,
    });
  });

  console.log(
    "done, changes:" +
      this.fileIndexer.changeList.length +
      " dirs:" +
      this.fileIndexer.dirList.length
  );

  let out = 0;
  while (null !== out) {
    out = await this.syncFiles(out);
    if (out !== null) {
      await this.reconnect();
    }
  }
  this.fileIndexer.closeDb();
  return;
};

FtpSync.prototype.halt = function () {
  if (this.stop) {
    this.stop = false;
    this.reset();
    return true;
  }

  return false;
};

FtpSync.prototype.cacheCheck = function (dir){
  for (let i = 0; i < this.dirCreationCache.length; i++) {
    if(this.dirCreationCache[i] === dir){
      return true
    }
  }

  return false;
}

FtpSync.prototype.createDir = async function (remoteDirPath) {
  const names = remoteDirPath.split("/").filter((name) => name !== "");
  let dircache = '/';
  let newdir = '';
  for (const name of names) {
    newdir = dircache+(dircache !== '/' ? '/' : '')+name;
    if (!this.cacheCheck(newdir)) {
      await this.client.cd(dircache);
      await this.client.sendIgnoringError("MKD " + name);
      this.dirCreationCache.push(newdir);
    }
    dircache = newdir
  }
};

FtpSync.prototype._openDir = async function (dir) {
  await this.client.sendIgnoringError("MKD " + dir);
};

FtpSync.prototype.syncFiles = async function (i) {
  if (this.halt()) {
    return;
  }
  try {
    if (i === 0) {
      await this.client.ensureDir(this.ftpBaseDir);
      if (this.halt()) {
        return;
      }
    }

    while (i < this.fileIndexer.changeList.length) {
      let pathInfo = pathLib.parse(this.fileIndexer.changeList[i].fullpath);
      let ftpDir =
        this.ftpBaseDir +
        "/" +
        upath.toUnix(pathLib.relative(this.options.dir, pathInfo.dir));
      //console.log(ftpDir + pathInfo.base);
      this.status = {
        fullPath: this.fileIndexer.changeList[i].fullpath,
        name: pathInfo.base,
        dirLocal: pathInfo.dir,
        dirFtp: ftpDir,
        stats: this.fileIndexer.changeList[i].stats,
      };
      if (!this.cacheCheck(ftpDir)) {
        await this.createDir(ftpDir);
      }
      if (this.halt()) {
        return;
      }
      await this.client.uploadFrom(
        this.fileIndexer.changeList[i].fullpath,
        ftpDir + "/" + pathInfo.base
      );
      if (this.halt()) {
        return;
      }
      this.totalSizeUploaded += this.fileIndexer.changeList[i].stats.size;
      await this.fileIndexer.updateStats(
        this.fileIndexer.changeList[i].fullpath,
        this.fileIndexer.changeList[i].stats
      );
      if (this.halt()) {
        return;
      }
      i++;
    }
  } catch (err) {
    return this.onUploadError(err) ? i : null;
  }
  return null;
};

module.exports = FtpSync;

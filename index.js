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
  this.uploadAvarageCounter = 1;
  this.nocache = true;
  this.skipedUploadSize = 0;
  this.excludeDirs = [];
  this.batches = [];
};

FtpSync.prototype.setExcludedDirs = function (dirs) {
  this.excludeDirs = dirs;
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
  this.ready = true;
  this.uploadAvarageCounter = 1;
  this.skipedUploadSize = 0;
  this.excludeDirs = [];
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
      secureOptions: {
        rejectUnauthorized: false
      }
    });
    //this.client.ftp.verbose = true
  } catch (err) {
    this.onConnectError(err);
  }
};

FtpSync.prototype.disconnect = function () {
  this.client.close();
};

FtpSync.prototype.reconnect = async function () {
  await this.client.close();
  await this.connect();
};

FtpSync.prototype.onConnectError = function (err) {
  console.log(err);
  throw err;
};

FtpSync.prototype.onUploadError = function (err, i) {

  //reset of connection of firewall
  if (err.code === "ECONNRESET") {
    return i;
  }
  //connection stopped
  if (err.code === "ECONNABORTED") {
    return i;
  }
  //fire or dir removed
  if (err.code === "ENOENT") {
    this.fileIndexer.fileErrors.push(this.fileIndexer.changeList[i].fullpath)
    return i + 1;
  }

  if (err.code === "EBUSY") {
    this.fileIndexer.fileErrors.push(this.fileIndexer.changeList[i].fullpath)
    return i + 1;
  }

  if (err.code === 425) {
    return i;
  }

  //user force stops the upload
  if (err.message.includes("User closed client during task")) {
    return -1;
  }


  throw err;
};

FtpSync.prototype.setDir = function (dir) {
  for (let i = 0; i < dir.length; i++) {
    dir[i] = pathLib.normalize(dir[i]);
    if (!fs.existsSync(dir[i])) {
      throw "Path does not exist";
    }
    this.batches.push({
        'dir':dir[i]
    });
  }
};

FtpSync.prototype.setRemotePath = function (dir) {
  this.ftpBaseDir = dir;
};

FtpSync.prototype.setDatabase = function (databaseName) {
  this.options.databaseName = databaseName;
};

FtpSync.prototype.initDb = async function (name) {
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

FtpSync.prototype.closeDb = function (name) {
  if (this.db !== null) {
    this.db.close();
    this.db = null;
  }
};

FtpSync.prototype.statusUpdate = function (info) { };
FtpSync.prototype.statusStart = function (info) { };
FtpSync.prototype.statusFileDone = function (info) { };

FtpSync.prototype.sync = async function () {
  if (this.options.databaseName === null || this.batches.length === 0) {
    throw "Options not set";
  }

  this.fileIndexer.reset();
  //scan all dirs
  for (let i = 0; i < this.batches.length; i++) {
    this.fileIndexer.setDatabase(this.options.databaseName);
    this.fileIndexer.setDir(this.batches[i].dir);
    this.fileIndexer.setExcludedDirs(this.excludeDirs);
    await this.fileIndexer.scan();
  }

  await this.connect();
  await this.fileIndexer.initDb();
  let uploadFileChange = null;
  let lastTime = 0;
  this.client.trackProgress((info) => {
    if (this.halt()) {
      return;
    }
    this.statusFtp = info;
    if (this.uploadSpeedTime == null) {
      this.uploadSpeedTime = new Date().getTime();
    }

    let timeDiff = (new Date().getTime() - this.uploadSpeedTime) / 1000;
    let bytesDiff = 0;
    bytesDiff = info.bytesOverall - this.uploadSpeedLastBytes;
    uploadFileChange = this.status.fullPath;
    this.uploadSpeedLastBytes = info.bytesOverall;


    if (bytesDiff > 0) {
      this.lastUploadSpeed = ((bytesDiff / (timeDiff < lastTime ? lastTime : timeDiff )) * 8);
    }

    lastTime = timeDiff;
    //add the skiped ones twoo
    info.bytesOverall = info.bytesOverall + this.skipedUploadSize;
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
      uploadSpeed: this.lastUploadSpeed
    });
    if (uploadFileChange === this.status.fullPath) {
      this.uploadSpeedTime = new Date().getTime();
    }
  });
  for (let i = 0; i < this.batches.length; i++) {
    console.log('nocache:' + this.nocache + ' | ' + this.batches[i].dir + ' -> ' + this.ftpBaseDir);
  }
  console.log(
    "done, changes:" +
    this.fileIndexer.changeList.length +
    " dirs:" +
    this.fileIndexer.dirList.length
  );

  this.statusStart({
    totalSize: this.fileIndexer.totalFileSize,
    totalFiles: this.fileIndexer.changeList.length,
    dirFiles: this.fileIndexer.stats.files,
    dirSize: this.fileIndexer.stats.size,
  });

  let out = 0;
  while (null !== out) {
    out = await this.syncFiles(out);
    if (out !== null) {
      await this.reconnect();
    }
  }
  await this.fileIndexer.closeDb();
  return;
};

FtpSync.prototype.halt = function () {
  if (this.stop) {
    this.disconnect();
    return true;
  }

  return false;
};

FtpSync.prototype.cacheCheck = function (dir) {
  for (let i = 0; i < this.dirCreationCache.length; i++) {
    if (this.dirCreationCache[i] === dir) {
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
    newdir = dircache + (dircache !== '/' ? '/' : '') + name;
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

FtpSync.prototype.updateLastmodified = async function (path, info) {
  let mod = new Date(info.mtimeMs);
  path = await this.client.protectWhitespace(path);
  await this.client.send('MFMT ' + mod.yyyymmddhhmmss() + ' ' + path);
}

FtpSync.prototype.lastmodifiedChanged = async function (path, info) {
  let latchange = await this.client.lastMod(path);
  let mod = new Date(info.mtimeMs);
  return latchange.yyyymmddhhmmss() != mod.yyyymmddhhmmss();
}

Date.prototype.yyyymmdd = function () {
  var yyyy = this.getFullYear();
  var mm = this.getUTCMonth() < 9 ? "0" + (this.getUTCMonth() + 1) : (this.getUTCMonth() + 1); // getMonth() is zero-based
  var dd = this.getUTCDate() < 10 ? "0" + this.getUTCDate() : this.getUTCDate();
  return "".concat(yyyy).concat(mm).concat(dd);
};

Date.prototype.yyyymmddhhmm = function () {
  var yyyymmdd = this.yyyymmdd();
  var hh = this.getUTCHours() < 10 ? "0" + this.getUTCHours() : this.getUTCHours();
  var min = this.getUTCMinutes() < 10 ? "0" + this.getUTCMinutes() : this.getUTCMinutes();
  return "".concat(yyyymmdd).concat(hh).concat(min);
};

Date.prototype.yyyymmddhhmmss = function () {
  var yyyymmddhhmm = this.yyyymmddhhmm();
  var ss = this.getUTCSeconds() < 10 ? "0" + this.getUTCSeconds() : this.getUTCSeconds();
  return "".concat(yyyymmddhhmm).concat(ss);
};

FtpSync.prototype.syncFiles = async function (i) {
  if (this.halt()) {
    return null;
  }
  try {
    if (i === 0) {
      await this.createDir(this.ftpBaseDir);
      if (this.halt()) {
        return null;
      }
    }
    let changed = true;
    let filePath = null;
    while (i < this.fileIndexer.changeList.length) {
      let pathInfo = pathLib.parse(this.fileIndexer.changeList[i].fullpath);
      let ftpDir =
        this.ftpBaseDir +
        "/" +
        upath.toUnix(pathLib.relative(this.getBaseDir(pathInfo.dir), pathInfo.dir));
      filePath = ftpDir + "/" + pathInfo.base;
      filePath = filePath.replace("//", "/");

      this.status = {
        index: i,
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
        return null;
      }
      if (!this.fileIndexer.hasAccess(this.fileIndexer.changeList[i].fullpath)) {
        this.fileIndexer.fileErrors.push(this.fileIndexer.changeList[i].fullpath);
      }
      if (this.nocache) {
        changed = true;
        try {
          changed = await this.lastmodifiedChanged(filePath, this.fileIndexer.changeList[i].stats);
        } catch (error) {
          if (error.code != 550) {
            throw error;
          }
        }
      }
      if (changed) {
        await this.client.uploadFrom(
          this.fileIndexer.changeList[i].fullpath,
          filePath
        );
      } else {
        this.skipedUploadSize += this.fileIndexer.changeList[i].stats.size;
      }

      await this.updateLastmodified(filePath, this.fileIndexer.changeList[i].stats);
      if (this.halt()) {
        return null;
      }
      this.totalSizeUploaded += this.fileIndexer.changeList[i].stats.size;
      await this.fileIndexer.updateStats(
        this.fileIndexer.changeList[i].fullpath,
        this.fileIndexer.changeList[i].stats
      );

      this.statusFileDone({
        current: this.status,
        basePath: this.ftpBaseDir,
        username: this.options.username,
        totalSize: this.fileIndexer.totalFileSize,
        totalSizeUploaded: this.totalSizeUploaded,
        totalFiles: this.fileIndexer.changeList.length,
        dirFiles: this.fileIndexer.stats.files,
        dirSize: this.fileIndexer.stats.size
      });

      if (this.halt()) {
        return null;
      }
      i++;
    }
  } catch (err) {
    let error = this.onUploadError(err, i);
    return error > -1 ? error : null;
  }
  return null;
};

FtpSync.prototype.fileExists = function (file) {
  try {
    if (fs.existsSync(file)) {
      return true;
    }
  } catch (err) {
    console.error(err);
    return false;
  }
}

FtpSync.prototype.getBaseDir = function (dir){
  if(this.batches.length === 1){
    return this.batches[0].dir;
  }

  for (let index = 0; index < this.batches.length; index++) {
    if (dir.substr(0, this.batches[index].dir.length).toUpperCase() == this.batches[index].dir.toUpperCase()) {
      let split = this.batches[index].dir.split(pathLib.sep);
      let dirto = split.slice(0, split.length - 1).join(pathLib.sep) + pathLib.sep;
      return dirto;
    }
  }

  return null;
}

FtpSync.prototype.remove = async function (file) {
  if (!this.fileExists(file)) {
    let pathInfo = pathLib.parse(file);
    let ftpDir =
      this.ftpBaseDir +
      "/" +
      upath.toUnix(pathLib.relative(this.getBaseDir(pathInfo.dir), pathInfo.dir));
    try {
      await this.client.remove(ftpDir + "/" + pathInfo.base);
    } catch (error) {
      if (error.code !== 550) {
        console.log('PURGE CODE:', error.code);
        console.log('PURGE ERROR:', error);
      }
    }
    try {
      if (!this.fileExists(pathInfo.dir)) {
        try {
          await this.client.removeDir(ftpDir);
        } catch (error) {
          if (error.code !== 550) {
            console.log('PURGE2 CODE:', error.code);
            console.log('PURGE2 ERROR:', error);
          }
        }
      }
      await this.fileIndexer.db.del(file);
    } catch (error) {
      console.log('PURGE3 CODE:', error.code);
      console.log('PURGE3 ERROR:', error);
    }
  }
}

FtpSync.prototype.purgeList = async function (files) {
  for (let i = 0; i < files.length; i++) {
    await this.remove(files[i]);
  }
}

FtpSync.prototype.purge = async function (callback) {

  await this.fileIndexer.initDb();
  let files = [];
  this.fileIndexer.db.createReadStream({ keys: true, values: false })
    .on('data', (file) => {
      if (this.fileExists(this.getBaseDir(file))) {
        if (!this.fileExists(file)) {
          files.push(file);
        }
      } else {
        callback(files);
        throw 'Path does not exist';
      }
    })
    .on('error', (err) => {
      this.fileIndexer.closeDb();
      throw err;
    })
    .on('end', async () => {
      callback(files);
    });
}

module.exports = FtpSync;

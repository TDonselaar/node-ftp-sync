"use strict";

const FileIndexer = require("./fileIndexer");

const level = require("level");
const pathLib = require("path");
const fs = require("fs");
const ftp = require("basic-ftp");
const upath = require("upath");

var FtpSync = function({ username, password, host }) {
    this.options = {
        dir: null,
        databaseName: null,
        username: username,
        password: password,
        host: host
    };
    this.enableLog = false;
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
    this.continueUpload = [];
    this.endFileList = [];
    this.blockedList = [];
    this.scanning = false;
    var this_ = this;
    this.fileIndexer.onAccessError = function(file) {
        this_.onFileError('LOCKED', file);
    };
};

FtpSync.prototype.log = function(text) {
    if (this.enableLog) {
        console.log(text);
    }
}

FtpSync.prototype.setExcludedDirs = function(dirs) {
    this.excludeDirs = dirs;
};

FtpSync.prototype.setEndFileList = function(files) {
    this.endFileList = files;
};

FtpSync.prototype.setBlockedFileList = function(files) {
    this.blockedList = files;
};

FtpSync.prototype.reset = async function() {
    await this.fileIndexer.reset();
    await this.closeDb();
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
    this.endFileList = [];
    this.blockedList = [];
    this.scanning = false;
};

FtpSync.prototype.check = function() {
    return this.client.access({
        host: this.options.host,
        user: this.options.username,
        password: this.options.password,
        secure: true,
    });
};

FtpSync.prototype.connect = async function() {
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

FtpSync.prototype.onFileError = function(type, file) {

}

FtpSync.prototype.disconnect = function() {
    this.client.close();
};

FtpSync.prototype.reconnect = async function() {
    await this.client.close();
    await this.connect();
};

FtpSync.prototype.onConnectError = function(err) {
    throw err;
};

FtpSync.prototype.onUploadError = function(err, i) {
    //reset of connection of firewall
    if (err.code === "ECONNRESET") {
        return i;
    }
    //connection stopped
    if (err.code === "ECONNABORTED") {
        return i;
    }

    //file removed
    if (err.code === "ENOENT") {
        this.fileIndexer.fileErrors.push(this.fileIndexer.changeList[i].fullpath);
        this.onFileError('REMOVED', this.fileIndexer.changeList[i].fullpath);
        this.skipedUploadSize += this.fileIndexer.changeList[i].stats.size;
        return i + 1;
    }
    //file locked
    if (err.code === "EBUSY") {
        this.fileIndexer.fileErrors.push(this.fileIndexer.changeList[i].fullpath);
        this.onFileError('LOCKED', this.fileIndexer.changeList[i].fullpath);
        this.skipedUploadSize += this.fileIndexer.changeList[i].stats.size;
        return i + 1;
    }
    //permission issue
    if (err.code === "EPERM") {
        this.fileIndexer.fileErrors.push(this.fileIndexer.changeList[i].fullpath);
        this.onFileError('PERMISSION', this.fileIndexer.changeList[i].fullpath);
        this.skipedUploadSize += this.fileIndexer.changeList[i].stats.size;
        return i + 1;
    }

    if (err.code === 425) {
        return i;
    }

    //user force stops the upload
    if (typeof err.message !== 'undefined' && err.message.includes("User closed client during task")) {
        return -1;
    }

    //when this is not an ftp error
    if (!this.isFtpError(err)) {
        this.onNoneFtpError(this.fileIndexer.changeList[i], err);
        return i + 1;
    }


    throw err;
};

FtpSync.prototype.onNoneFtpError = function(file, err) {

}

FtpSync.prototype.isFtpError = function(err) {
    return this.isConnectionError(err) || this.isUserNamePasswordError(err) || this.isStorageFull(err);
}

FtpSync.prototype.isConnectionError = function(error) {
    if (typeof error.code !== 'undefined') {
        return (error.code == 421 ||
            error.code == 425 ||
            error.code == 426 ||
            error.code == 434 ||
            error.code == 'ENOTFOUND' ||
            error.code == 'ETIMEDOUT' ||
            error.code == 'EACCES' ||
            (typeof error.message !== 'undefined' && error.message.includes('Timeout'))
        );
    }
    return false;
}

FtpSync.prototype.isUserNamePasswordError = function(error) {
    if (typeof error.code !== 'undefined') {
        return (error.code == 331 ||
            error.code == 332 ||
            error.code == 430 ||
            error.code == 530 ||
            error.code == 532
        );
    }
    return false;
}

FtpSync.prototype.isStorageFull = function(error) {
    if (typeof error.code !== 'undefined') {
        return (error.code == 452);
    }
}

FtpSync.prototype.setDir = function(dir) {
    for (let i = 0; i < dir.length; i++) {
        dir[i] = pathLib.normalize(dir[i]);
        if (!fs.existsSync(dir[i])) {
            throw "Path does not exist";
        }
        this.batches.push({
            'dir': dir[i]
        });
    }
};

FtpSync.prototype.setRemotePath = function(dir) {
    this.ftpBaseDir = dir;
};

FtpSync.prototype.setDatabase = function(databaseName) {
    this.options.databaseName = databaseName;
};

FtpSync.prototype.initDb = async function(name) {
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

FtpSync.prototype.closeDb = async function(name) {
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

FtpSync.prototype.statusUpdate = function(info) {};
FtpSync.prototype.statusStart = function(info) {};
FtpSync.prototype.statusFileDone = function(info) {};

FtpSync.prototype.updateStatus = function() {
    this.statusUpdate({
        current: this.status,
        ftp: {},
        basePath: this.ftpBaseDir,
        username: this.options.username,
        totalSize: this.fileIndexer.totalFileSize,
        totalSizeUploaded: this.totalSizeUploaded,
        totalFiles: this.fileIndexer.changeList.length,
        dirFiles: this.fileIndexer.stats.files,
        dirSize: this.fileIndexer.stats.size,
        uploadSpeed: this.lastUploadSpeed
    })
};

FtpSync.prototype.sync = async function() {
    if (this.options.databaseName === null || this.batches.length === 0) {
        throw "Options not set";
    }
    this.log("Starting sync");
    await this.fileIndexer.reset();

    //scan all dirs
    this.scanning = true;
    //set settings
    this.fileIndexer.setDatabase(this.options.databaseName);
    this.fileIndexer.setExcludedDirs(this.excludeDirs);
    this.fileIndexer.setEndFileList(this.endFileList);
    this.fileIndexer.setBlockedFileList(this.blockedList);

    for (let i = 0; i < this.batches.length; i++) {
        this.log("Scanning " + this.batches[i].dir);
        this.fileIndexer.setDir(this.batches[i].dir);
        await this.fileIndexer.scan();
        this.log("Scanning done");
    }
    //add files ot the end of the list if needed.
    this.fileIndexer.addAllToEnd();
    this.scanning = false;

    //set the first file before we start if there are files
    if (this.fileIndexer.changeList.length > 0) {
        let pathInfo = pathLib.parse(this.fileIndexer.changeList[0].fullpath);
        let ftpDir =
            this.ftpBaseDir +
            "/" +
            upath.toUnix(pathLib.relative(this.getBaseDir(pathInfo.dir), pathInfo.dir))
        this.status = {
            index: 0,
            fullPath: this.fileIndexer.changeList[0].fullpath,
            name: pathInfo.base,
            dirLocal: pathInfo.dir,
            dirFtp: ftpDir,
            stats: this.fileIndexer.changeList[0].stats,
        };
    }

    await this.connect();
    this.log("Connected to ftp");
    await this.fileIndexer.initDb();
    this.log("Setup file index db");
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
            this.lastUploadSpeed = ((bytesDiff / (timeDiff < lastTime ? lastTime : timeDiff)) * 8);
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
        this.log('nocache:' + this.nocache + ' | ' + this.batches[i].dir + ' -> ' + this.ftpBaseDir);
    }
    this.log(
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

FtpSync.prototype.halt = function() {
    if (this.stop) {
        this.disconnect();
        return true;
    }

    return false;
};

FtpSync.prototype.cacheCheck = function(dir) {
    for (let i = 0; i < this.dirCreationCache.length; i++) {
        if (this.dirCreationCache[i] === dir) {
            return true
        }
    }

    return false;
}

FtpSync.prototype.createDir = async function(remoteDirPath) {
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

FtpSync.prototype._openDir = async function(dir) {
    await this.client.sendIgnoringError("MKD " + dir);
};

FtpSync.prototype.updateLastmodified = async function(path, info) {
    let mod = new Date(info.mtimeMs);
    path = await this.client.protectWhitespace(path);
    await this.client.send('MFMT ' + mod.yyyymmddhhmmss() + ' ' + path);
}

FtpSync.prototype.formatTime = function(time) {
    return Math.trunc(time / 1000);
};

FtpSync.prototype.lastmodifiedChanged = async function(path, info) {
    let lastchange = await this.client.lastMod(path);
    let mod = new Date(info.mtimeMs);
    return lastchange.yyyymmddhhmmss() != mod.yyyymmddhhmmss();
}

Date.prototype.yyyymmdd = function() {
    var yyyy = this.getFullYear();
    var mm = this.getUTCMonth() < 9 ? "0" + (this.getUTCMonth() + 1) : (this.getUTCMonth() + 1); // getMonth() is zero-based
    var dd = this.getUTCDate() < 10 ? "0" + this.getUTCDate() : this.getUTCDate();
    return "".concat(yyyy).concat(mm).concat(dd);
};

Date.prototype.yyyymmddhhmm = function() {
    var yyyymmdd = this.yyyymmdd();
    var hh = this.getUTCHours() < 10 ? "0" + this.getUTCHours() : this.getUTCHours();
    var min = this.getUTCMinutes() < 10 ? "0" + this.getUTCMinutes() : this.getUTCMinutes();
    return "".concat(yyyymmdd).concat(hh).concat(min);
};

Date.prototype.yyyymmddhhmmss = function() {
    var yyyymmddhhmm = this.yyyymmddhhmm();
    var ss = this.getUTCSeconds() < 10 ? "0" + this.getUTCSeconds() : this.getUTCSeconds();
    return "".concat(yyyymmddhhmm).concat(ss);
};

FtpSync.prototype.resumeUpload = async function(from, to, info) {
    this.log("Get file size");
    let size = 0;
    try {
        let lastchange = await this.client.lastMod(to);
        let mod = new Date(info.mtimeMs);
        this.log(this.formatTime(mod.getTime()));
        this.log(this.formatTime(lastchange.getTime()));
        //we can't append file because its changed within the appding of the file
        if (this.formatTime(mod.getTime()) > this.formatTime(lastchange.getTime())) {
            this.log('File changed within the resume');
            return false;
        }
        size = await this.client.size(to);

    } catch (error) {
        if (error.code != 550) {
            throw error;
        }

        return false;
    }
    this.log("Open stream");
    let stream = fs.createReadStream(from, {
        start: size
    });
    this.skipedUploadSize = size;
    this.log("apend upload");
    await this.client.appendFrom(stream, to);
    return true;
};

FtpSync.prototype.removeFileFromResume = function(src) {
    for (let i = 0; i < this.continueUpload.length; i++) {
        if (this.continueUpload[i] === src) {
            this.continueUpload.splice(i, 1);
            break;
        }
    }
}

FtpSync.prototype.syncFiles = async function(i) {
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
        let totalFiles = this.fileIndexer.changeList.length;
        while (i < totalFiles) {
            let pathInfo = pathLib.parse(this.fileIndexer.changeList[i].fullpath);
            let ftpDir =
                this.ftpBaseDir +
                "/" +
                upath.toUnix(pathLib.relative(this.getBaseDir(pathInfo.dir), pathInfo.dir));
            filePath = ftpDir + "/" + pathInfo.base;
            filePath = filePath.replace("//", "/");
            let resumeUpload = false;

            this.status = {
                index: i,
                fullPath: this.fileIndexer.changeList[i].fullpath,
                name: pathInfo.base,
                dirLocal: pathInfo.dir,
                dirFtp: ftpDir,
                stats: this.fileIndexer.changeList[i].stats,
            };

            if (this.continueUpload.includes(this.status.fullPath)) {
                resumeUpload = true;
            }

            this.log("[" + i + "/" + totalFiles + "] Starting [" + (resumeUpload ? "RESUME" : "UPLOAD") + "] of " + this.status.fullPath);

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
                    this.log('Last mod check');
                    changed = await this.lastmodifiedChanged(filePath, this.fileIndexer.changeList[i].stats);
                } catch (error) {
                    if (error.code != 550) {
                        throw error;
                    }
                }
            }
            /*
            if ((Math.random() * 100) < (resumeUpload ? 90 : 10)) {
                //this.fileIndexer.changeList[i].fullpath += 'blablabla';
                throw "test error";
            }*/

            if (changed) {
                if (resumeUpload) {
                    let uploadedResumed = await this.resumeUpload(this.fileIndexer.changeList[i].fullpath, filePath, this.fileIndexer.changeList[i].stats);
                    if (uploadedResumed) {
                        this.removeFileFromResume(this.status.fullPath);
                    } else {
                        this.log('Failed to resume upload uploading normaly');
                        await this.client.uploadFrom(
                            this.fileIndexer.changeList[i].fullpath,
                            filePath
                        );
                    }
                } else {
                    await this.client.uploadFrom(
                        this.fileIndexer.changeList[i].fullpath,
                        filePath
                    );
                }
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
                totalFiles: totalFiles,
                dirFiles: this.fileIndexer.stats.files,
                dirSize: this.fileIndexer.stats.size
            });
            this.log("[" + i + "/" + totalFiles + "] Done");
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

FtpSync.prototype.fileExists = function(file) {
    try {
        if (fs.existsSync(file)) {
            return true;
        }
    } catch (err) {
        console.error(err);
        return false;
    }
}

FtpSync.prototype.getBaseDir = function(dir) {
    if (this.batches.length === 1) {
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

FtpSync.prototype.remove = async function(file) {
    if (!this.fileExists(file)) {
        this.log('Ftp removing:' + file);
        let pathInfo = pathLib.parse(file);
        let ftpDir =
            this.ftpBaseDir +
            "/" +
            upath.toUnix(pathLib.relative(this.getBaseDir(pathInfo.dir), pathInfo.dir));
        try {
            await this.client.remove(ftpDir + "/" + pathInfo.base);
        } catch (error) {
            if (error.code !== 550) {
                await this.removeErrorHandel(error);
            }
        }
        try {
            if (!this.fileExists(pathInfo.dir)) {
                try {
                    await this.client.removeDir(ftpDir);
                } catch (error) {
                    if (error.code !== 550) {
                        await this.removeErrorHandel(error);
                    }
                }
            }
            await this.fileIndexer.db.del(file);
        } catch (error) {
            await this.removeErrorHandel(error);
        }
    }
}

FtpSync.prototype.removeErrorHandel = async function(error) {
    if (error.code !== 550) {
        if (error.code === "ECONNRESET" ||
            error.code === "ECONNABORTED") {
            await this.reconnect();
        } else {
            throw err;
        }
    }
};

FtpSync.prototype.purgeList = async function(files) {
    for (let i = 0; i < files.length; i++) {
        try {
            await this.remove(files[i]);
        } catch (err) {
            return err;
        }
    }
}

FtpSync.prototype.purge = async function(callback) {

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
            this.fileIndexer.closeDb().then(() => {
                throw err;
            }).catch(() => {
                throw err;
            });
        })
        .on('end', async() => {
            callback(files);
        });
}

module.exports = FtpSync;
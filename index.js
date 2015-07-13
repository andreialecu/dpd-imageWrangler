/*jslint node: true */
'use strict';

/**
 * Module dependencies
 */

var Resource = require('deployd/lib/resource'),
	Session = require('deployd/lib/session'),
	util = require('util'),
	multiparty = require('multiparty'),
	fs = require('fs'),
	path = require('path'),
	gm = require('gm').subClass({imageMagick: true}),
	AWS = require('aws-sdk'),
	Promise = require('bluebird'),
	request = require('request'),
	ms = require('millisecond');
/**
 * Module setup.
 */

function ImageWrangler(name, options) {
	Resource.apply(this, arguments);
	if (this.config.accessKey && this.config.accessSecret && this.config.bucket) {
		AWS.config.update({
			accessKeyId: this.config.accessKey,
			secretAccessKey: this.config.accessSecret,
			bucket: this.config.bucket,
			region: this.config.region
		});
	}
}
util.inherits(ImageWrangler, Resource);

ImageWrangler.prototype.clientGeneration = true;

ImageWrangler.events = ['Post', 'File', 'Saving', 'Saved'];

ImageWrangler.basicDashboard = {
	settings: [{
		name: 'accessKey',
		type: 'text',
		description: 'The AWS access key id'
	}, {
		name: 'accessSecret',
		type: 'text',
		description: 'The AWS secret access key'
	}, {
		name: 'region',
		type: 'text',
		description: 'The AWS region'
	}, {
		name: 'tasks',
		type: 'textarea',
		description: 'JSON object detailing the image specs to be created for each image uploaded to this endpoint'
	}, {
		name: 'bucket',
		type: 'text',
	}, {
		name: 'basePath',
		type: 'text',
		description: 'Base URL for where someone could GET the file off the bucket (cloud front url if you are using that)'
	}, {
		name: 'publicRead',
		type: 'checkbox',
		description: 'When files are uploaded to your bucket, automatically set public read access?'
	},{
		name: 'cacheLifetime',
		type: 'text',
		description: 'Set the time (ie. \'5 years\') that images can be cached by browsers (Far Future Headers)'
	}, {
		name: 'internalOnly',
		type: 'checkbox',
		description: 'Only allow internal scripts to send email'
	}, {
		name: 'imageQuality',
		type: 'text',
		description: '0-100 (default 95)'
	}]
};

function cleanupPath(path) {
	return path.replace('//', '/'); // replace double slash with single slash
}

ImageWrangler.prototype.process = function(ctx) {
	var wrangler = this;
	var req = ctx.req;
	var resizeTasks = JSON.parse(this.config.tasks);
	var parts = ctx.url.split('/').filter(function(p) {
		return p;
	});

	if (!resizeTasks[parts[0]]) {
		return ctx.done("invalid upload scope");
	}
	resizeTasks = resizeTasks[parts[0]];

	var subDirPath = '';
	if (parts.length > 0) subDirPath = parts.join('/');

	var form = new multiparty.Form();
	var remaining = 0;
	var files = [];
	var error;

	var responseObject = {};
	var cleanseFilename = function(incomingFilename) {
		//console.log("incoming filename: " + incomingFilename);
		var filename = incomingFilename;
		var extension = null;
		if (incomingFilename.indexOf('.') != -1) {
			var pieces = incomingFilename.split('.');
			extension = pieces.pop();
			filename = pieces.join('.');
		}
		//console.log("filename: " + filename);
		//console.log('extension: ' + extension);
		filename = filename.replace(/\s+/g, '-').toLowerCase(); //converst space to dash
		//console.log('replaced spaces with dashes: ' + filename);
		filename = filename.replace(/[^a-z0-9_\-]/gi, ''); // drop all other funny business
		//console.log('dropped bad characters: ' + filename);
		if (extension) {
			//console.log('completed result: ' + filename + '.' + extension);
			return filename + '.' + extension;
		}
		return filename;
	};
	var resizeFile = function(part, buffer) {
		function next(task, savedFile) {
			var size = task ? task.suffix : "original";
			responseObject[size] = wrangler.config.basePath + savedFile.replace(/^\/+/, "");
			resizeFile(part, buffer);
		}

		if (resizeTasks.length > 0) {
			var task = resizeTasks.pop();
			//console.log('task: ' + JSON.stringify(task));

			var output = cleanseFilename(part.filename).split('.');
			var outputName = output[0] + '-' + task.suffix + '.' + output[1];

			var quality = 95;
			if (wrangler.config.imageQuality) {
				quality = wrangler.config.imageQuality;
			}
			var completionBlock = function(err, stream) {
				if (!err) {
					wrangler.uploadFile(ctx, {
						task: task,
						originalFilename: part.filename,
						originalPath: subDirPath,
						filename: '/' + subDirPath + '/' + outputName,
						mime: part.headers["content-type"]
					}, stream, next);
				} else {
					//console.log(' error writing: ' + err);
					ctx.done(err);
				}
			};

			var resizeImage = function() {
				if (task.crop) {
					gm(buffer)
						.quality(quality)
						.autoOrient()
						.resize(task.width, task.height, '^')
						.gravity('Center')
						.extent(task.width, task.height)
						.stream(function(err, stdout, stderr) {
							completionBlock(err, stdout);
						});
				} else {
					gm(buffer)
						.quality(quality)
						.autoOrient()
						.flatten()
						.resize(task.width, task.height, '>')
						.stream(function(err, stdout, stderr) {
							completionBlock(err, stdout);
						});
				}
			};
			var resizeVectorial = function() {

				if (task.crop) {
					gm(buffer)
						.in("-colorspace", "srgb")
						.density(300,300)
						.bitdepth(8)
						.strip()
						.trim()
						.quality(quality)
						//.flatten()
						.resize(task.width, task.height, '^')
						.gravity('Center')
						.extent(task.width, task.height)
						.setFormat("PNG")
						.stream(function(err, stdout, stderr) {
							completionBlock(err, stdout);
						});
				} else {
					gm(buffer)
						.in("-colorspace", "srgb")
						.density(300,300)
						.bitdepth(8)
						.strip()
						.trim()
						.quality(quality)
						//.flatten()
						.resize(task.width, task.height, '>')
						.setFormat("PNG")
						.stream(function(err, stdout, stderr) {
							completionBlock(err, stdout);
						});
				}
			};

			gm(buffer).format(function(err, value) {
				if (err) {
					ctx.done(err);
					return;
				}

				if ((/EPT|PS/i).test(value)) {
					resizeVectorial();
				} else {
					resizeImage();
				}

			});
		} else {
			if (req.headers.referer) {
				ctx.done(null, responseObject);
			} else {
				ctx.done(null, files);
			}
		}
	};

  form.on('field', function(field, value) {
		if (field && field.toLowerCase() === "downloadurl") {
			var url = value.trim();

			var stream = request.get(url);

			stream.on('response', function(response) {
				stream.headers = response.headers['content-type'];
				stream.filename = url.split('/').pop();
				form.emit('part', stream);
		  });

		}
	});

	form.on('part', function(part) {
		remaining++;
		//write original version to s3 for safe keeping
		var output = cleanseFilename(part.filename).split('.');
		var outputName = output[0] + '-original.' + output[1];

		var readPromise = wrangler.readStream(part).catch(function(err) {
			return ctx.done(err);
		});

		function uploadOriginalFile(path) {
			readPromise.then(function(buffer){
				wrangler.uploadFile(ctx, {
					originalFilename: part.filename,
					originalPath: subDirPath,
					filename: path,
					mime: part.headers["content-type"]
				}, buffer, function(task, savedFile) {
					var size = task ? task.suffix : "original";
					responseObject[size] = wrangler.config.basePath + savedFile.replace(/^\/+/, "");
					resizeFile(part, buffer);
				});
			});
		}

		if (wrangler.events.File) {
			var domain = {
				data: {
					originalFilename: part.filename,
					path: subDirPath,
					filename: outputName,
					headers: part.headers,
					bytesExpected: part.bytesExpected
				}
			};
			wrangler.events.File.run(ctx, domain, function(err) {
				if (err) {
					part.resume();
					return ctx.done(err);
				}
				uploadOriginalFile(cleanupPath('/' + domain.data.path + '/' + domain.data.filename));
			});
		} else {
			uploadOriginalFile(cleanupPath('/' + subDirPath + '/' + outputName));
		}

	});
	form.on('error', function(err) {
		ctx.done(err);
		error = err;
	});

	form.parse(req);
	req.resume();
};

/**
 * Module methodes
 */

ImageWrangler.prototype.handle = function(ctx, next) {
	var req = ctx.req;
	var domain = {
		url: ctx.url
	};
	var wrangler = this;

	if (!this.config.basePath) this.config.basePath = '';

	if (!ctx.req.internal && this.config.internalOnly) {
		return ctx.done({
			statusCode: 403,
			message: 'Forbidden'
		});
	}

	if (req.method === 'POST' && !req.internal && req.headers['content-type'].indexOf('multipart/form-data') === 0) {
		if (wrangler.events.Post) {
			wrangler.events.Post.run(ctx, {}, function(err) {
				if (err) return ctx.done(err);
				wrangler.process(ctx);
			});
		} else {
			wrangler.process(ctx);
		}
		return;
	}

	next();
};

ImageWrangler.prototype.uploadFile = function(ctx, config, stream, fn) {
	var wrangler = this;
	//console.log('filename:' + filename);
	//console.log('mime:' + mime);

	function uploadFn(domain) {
		var s3config = {
			Bucket: wrangler.config.bucket,
			Key: domain.data.filename.replace(/^\/+/, ""),
			ContentType: domain.data.mime,
			Body: stream
		};
		if (wrangler.config.publicRead) {
			s3config.ACL = 'public-read';
		}

		// Set Far Future Headers
		var cacheLifetime = ms(wrangler.config.cacheLifetime);
		if (cacheLifetime > 0) {
			s3config.CacheControl = 'public, max-age='+ cacheLifetime / 1000;
			s3config.ResponseCacheControl = s3config.CacheControl;
			s3config.Expires = Math.floor(new Date((cacheLifetime + Date.now()) / 1000));
			s3config.ResponseExpires = s3config.Expires;
		}

		var upload = new AWS.S3.ManagedUpload({params: s3config});
		upload.send(function(err, data) {
			if (err) return ctx.done(err);
			if (wrangler.events.Saved) {
				wrangler.events.Saved.run(ctx, {
					data: {
						task: config.task,
						originalFilename: config.originalFilename,
						originalPath: config.originalPath,
						savedFilename: domain.data.filename,
						mime: domain.data.mime,
						baseUrl: wrangler.config.basePath
					}
				}, function(err) {
					if (err) return ctx.done(err);
					fn(config.task, domain.data.filename);
				});
			} else {
				fn(config.task, domain.data.filename);
			}
		});
	}

	var domain = {
		data: {
			task: config.task,
			originalFilename: config.originalFilename,
			originalPath: config.originalPath,
			filename: config.filename,
			mime: config.mime
		}
	};
	if (wrangler.events.Saving) {
		wrangler.events.Saving.run(ctx, domain, function(err) {
			if (err) return ctx.done(err);
			uploadFn(domain);
		});
	} else {
		uploadFn(domain);
	}
};

ImageWrangler.prototype.readStream = function(stream) {
	return new Promise(function(resolve, reject) {
		var buffer = [];
		stream.on('data', function(data) {
			buffer.push(data);
		}).on('end', function() {
			resolve(Buffer.concat(buffer));
		}).on('error', function(err) {
			reject(err);
		});
	});
};

/**
 * Module export
 */

module.exports = ImageWrangler;

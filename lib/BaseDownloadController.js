/*
 * Copyright 2019 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const objectPath = require('object-path');
const yaml = require('js-yaml');
const fs = require('fs-extra');
const hash = require('object-hash');
const clone = require('clone');

const CompositeController = require('./CompositeController');

const FetchEnvs = require('./FetchEnvs');

module.exports = class BaseDownloadController extends CompositeController {
  constructor(params) {
    params.finalizerString = params.finalizerString || 'children.downloads.deploy.razee.io';
    super(params);
  }

  async added() {
    let requests = objectPath.get(this.data, ['object', 'spec', 'requests'], []);

    // when failure to download optional resource occurs, should continue to download other requests, but shouldnt reconcile children
    let optionalResourceFailure = 0;
    let lastModifiedArray = objectPath.get(this.data, ['object', 'status', 'last-modified'], []);
    let newLastModifiedArray = [];

    for (var i = 0; i < requests.length; i++) {
      let request = requests[i];
      let requestHash = hash(request);

      let file;
      let fileCachePath = `./download-cache/${this.namespace}/${this.name}/${requestHash}`;
      let optional = request.optional || false;
      let reqOpt = clone(request.options);
      let url = objectPath.get(request, 'options.uri') || objectPath.get(request, 'options.url');

      if (objectPath.has(request, 'options.headers.If-Modified-Since') || objectPath.has(request, 'options.headers.If-None-Match')) {
        this.log.warn('Should not include If-Modified-Since/If-None-Match in definition headers, removing from request..');
        objectPath.del(reqOpt, 'headers.If-Modified-Since');
        objectPath.del(reqOpt, 'headers.If-None-Match');
      }

      let imsObj = lastModifiedArray.find((el) => objectPath.get(el, 'hash') == requestHash && objectPath.has(el, 'last-modified'));
      let fileCached = await fs.pathExists(fileCachePath);
      this.log.debug(`Request Hash ${requestHash} ${imsObj ? 'found' : 'not found'} in .status.last-modified array and file ${fileCached ? 'is' : 'is not'} cached`);
      if (imsObj && fileCached) {
        this.log.debug(`Adding headers.If-Modified-Since to request from Request Hash ${requestHash}`);
        objectPath.set(reqOpt, 'headers.If-Modified-Since', objectPath.get(imsObj, 'last-modified'));
      }

      try {
        reqOpt = await this._fetchHeaderSecrets(reqOpt);
      } catch (e) {
        // error fetching header secrets
        if (optional && e.code == 404) {
          ++optionalResourceFailure;
          this.log.warn(e.message);
          this.updateRazeeLogs('warn', { controller: 'BaseDownload', warn: e.message, url: url });
          this.log.debug(`skipping download for ${url}`);
          continue;
        } else {
          return Promise.reject(e.message);
        }
      }

      try {
        let res = await this.download(reqOpt);
        if (res.toJSON instanceof Function) {
          res = res.toJSON();
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          this.log.debug(`Download ${res.statusCode} ${url}`);
          file = yaml.loadAll(res.body);
          if (Array.isArray(file) && file.length == 1) { file = file[0]; }

          // TODO if last-modified doesnt exist try etag
          // use with request at .headers.If-None-Match
          let resLM = objectPath.get(res, 'headers.last-modified');
          if (resLM) {
            await fs.outputJson(fileCachePath, file);
            newLastModifiedArray[i] = { hash: requestHash, url: url, 'last-modified': resLM };
          }
        } else if (res.statusCode == 304 && fileCached) {
          this.log.debug(`Download ${res.statusCode} Not Modified ${url}`);
          file = await fs.readJson(fileCachePath);
          newLastModifiedArray[i] = { hash: requestHash, url: url, 'last-modified': objectPath.get(imsObj, 'last-modified') };
        } else {
          this.log.debug(`Download failed: ${res.statusCode} | ${url}`);
          throw { statusCode: res.statusCode, uri: url };
        }
      } catch (e) {
        if (optional) {
          ++optionalResourceFailure;
          this.log.warn(e.message || e);
          this.updateRazeeLogs('warn', { controller: 'BaseDownload', warn: `Error downloading file. StatusCode: ${e.statusCode}`, url: url });
          file = [];
          newLastModifiedArray[i] = { hash: requestHash, url: url };
        } else {
          if (e.message === undefined) this.log.error(e);
          return Promise.reject(`uri: ${reqOpt.uri || reqOpt.url}, statusCode: ${e.statusCode}, message: ${e.message}`);
        }
      }

      try {
        await this._decomposeFile(file);
      } catch (e) {
        let msg = `Error applying file to kubernetes. StatusCode: ${e.statusCode} url: ${url} message: ${objectPath.get(e, 'body.message', e)}`;
        if (optional) {
          ++optionalResourceFailure;
          this.log.warn(msg);
          this.updateRazeeLogs('warn', { controller: 'BaseDownload', warn: `Error applying file to kubernetes, see logs for details. StatusCode: ${e.statusCode}`, url: url });
        } else {
          return Promise.reject(msg);
        }
      }

    }

    // update the last-modified array
    let res = await this.patchSelf({
      status: {
        'last-modified': newLastModifiedArray
      }
    }, { status: true });
    objectPath.set(this.data, 'object', res); // save latest patch response

    if (optionalResourceFailure > 0) {
      let msg = `${optionalResourceFailure} optional resource(s) failed to process.. skipping reconcileChildren`;
      this.log.warn(msg);
      this.updateRazeeLogs('warn', { controller: 'BaseDownload', warn: msg });
    } else {
      await this.reconcileChildren();
    }

  }

  // Helpers ==================================
  async _decomposeFile(file) {
    let kind = objectPath.get(file, ['kind'], '');
    let items = objectPath.get(file, ['items']);

    if (Array.isArray(file)) {
      let error;
      let res = await Promise.all(file.map(async f => {
        try {
          return await this._decomposeFile(f);
        } catch (e) {
          error = error || e;
        }
      }));
      return error ? Promise.reject(error) : res;
    } else if (kind.toLowerCase() == 'list' && Array.isArray(items)) {
      let error;
      let res = await Promise.all(items.map(async f => {
        try {
          return await this._decomposeFile(f);
        } catch (e) {
          error = error || e;
        }
      }));
      return error ? Promise.reject(error) : res;
    } else if (file) {
      return await this._saveChild(file);
    }
  }

  async _fetchHeaderSecrets(requestOptions) {
    requestOptions = clone(requestOptions);
    let headers = objectPath.get(requestOptions, 'headers');
    if (headers) {
      for (let [hKey, hObject] of Object.entries(headers)) {
        let secretRef = objectPath.get(hObject, 'valueFrom.secretKeyRef');
        if (secretRef) {
          let secretName = objectPath.get(secretRef, 'name');
          let secretNamespace = objectPath.get(secretRef, 'namespace', this.namespace);
          let secretKey = objectPath.get(secretRef, 'key');
          try {
            objectPath.set(headers, [hKey], await this._getSecretData(secretName, secretKey, secretNamespace));
          } catch (e) {
            const error = new Error(`Unable to fetch header secret data. { name: ${secretName}, namespace: ${secretNamespace}, key: ${secretKey} }: ${objectPath.get(e, 'error.message')}`);
            error.code = objectPath.get(e, 'error.code');
            throw error;
          }
        }
      }
    }

    const reqopt = new FetchEnvs(this);
    const headersFrom = objectPath.get(requestOptions, 'headersFrom');
    if (headersFrom) {
      let headersFromTemp;
      try {
        headersFromTemp = await reqopt.processEnvFrom(headersFrom);
      } catch(e) {
        const err = new Error(`Unable to fetch header secrets with headersFrom. ${e.message}`);
        err.code = e.code;
        throw err;
      }
      let mergedHeaders = { ...headers };
      for (const header of headersFromTemp) {
        const data = header?.data;
        mergedHeaders = { ...mergedHeaders, ...data };
      }
      requestOptions = { ...requestOptions, headers: mergedHeaders };
    }

    return requestOptions;
  }

  async _getSecretData(name, key, ns) {
    ns = ns || this.namespace;
    let res = await this.kubeResourceMeta.request({ uri: `/api/v1/namespaces/${ns}/secrets/${name}`, json: true });
    let secret = Buffer.from(objectPath.get(res, ['data', key], ''), 'base64').toString();
    if (secret === '') {
      throw {
        name: 'StatusCodeError',
        statusCode: 404,
        message: `404 - key "${key}" not found in secret "${name}", in namespace "${ns}"`,
        error: {
          kind: 'Status',
          apiVersion: 'v1',
          metadata: {},
          status: 'Failure',
          message: `key "${key}" not found in secret "${name}", in namespace "${ns}"`,
          reason: 'NotFound',
          details: { 'name': name, 'namespace': ns, 'kind': 'secrets', 'key': key },
          code: 404
        }
      };
    }
    return secret;
  }

  async _saveChild(child) {
    let res = await this.applyChild(child);
    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
      return Promise.reject(res);
    }
    return res;
  }

  async download() {
    // Input: request options
    // Output: http request full resonse with a 'body' element
    // Do not send back anything you dont want applied to kube
    throw Error('Override BaseDownloadController.download in the subclass.');
  }
};

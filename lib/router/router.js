// (c)2015-2016 Internet of Coins / Metasync / Joachim de Koning
// hybrixd - router.js
// Routes incoming path array xpath to asynchronous processes.

const fileHashes = {}; // Keep file hashes cached

const MAX_ROUTER_PATH_LOG_LENGTH = 200;

// required libraries in this context
const fs = require('fs');
const DJB2 = require('../../common/crypto/hashDJB2'); // fast DJB2 hashing
// TODO var cache = require('./cache');

// routing submodules (keep in alphabetical order)
const asset = require('./asset');
const command = require('./command');
const engine = require('./engine');
const list = require('./list');
const help = require('./help');
const meta = require('./meta');
const proc = require('./proc');
const source = require('./source');
const report = require('./report');
const wchan = require('./wchan');
const xauth = require('./xauth');
const version = require('./version');
const qrtzProcess = require('../scheduler/process');
const conf = require('../conf/conf');

let lastRoutedPath = ''; // avoid double display logging of routing

// Please keep in alphabetical order and keep alias letter reserved
const routeRootMap = {
  asset: asset.process,
  command: command.process,
  engine: engine.process,
  list: list.process,
  meta: meta.process,
  help: help.serve,
  proc: proc.process,
  report: report.serve,
  source: source.process,
  version: version.serve,
  wchan: wchan.process,
  xauth: xauth.processX,
  ychan: xauth.processY,
  zchan: xauth.processZ
};

const refs = ['asset', 'source', 'engine'];

const dynamicallyLoadUiScript = `<script>
const apiLocation = window.location.href.startsWith(window.location.origin+'/api')
  ?window.location.origin+'/api'
  :window.location.origin;
const SCRIPT=document.createElement('SCRIPT');
SCRIPT.src=apiLocation+'/s/ui/ui.js';
document.head.appendChild(SCRIPT);
const LINK=document.createElement('LINK');
LINK.rel="stylesheet";
LINK.href=apiLocation+'/s/ui/ui.css';
document.head.appendChild(LINK);
  </script>`;

function refList (list, sessionID) {
  if (list === 'proc') return qrtzProcess.getProcessList(sessionID);
  return refs.includes(list) && list !== 'proc'
    ? Object.keys(global.hybrixd[list])
    : undefined;
}

const sources = ['asset', 'source', 'engine', 'proc'];

function isValidRef (it, item, sessionID) {
  if (typeof it !== 'object' || it === null || !it.hasOwnProperty('_list')) return false;
  const list = it['_list'];
  if (it._options instanceof Array) return it._options.includes(item);
  if (list === 'proc') return qrtzProcess.processExists(item, sessionID);
  else if (sources.includes(list)) return global.hybrixd[list].hasOwnProperty(item);
  else return true;
}

// Check whether a route is valid according to router/routes.json
function isValidPath (xpath, sessionID) {
  if (xpath.length === 0) xpath.push('help');
  const it = global.hybrixd.routetree; // iterate through routes.json
  return xpath[0] === 'help'
    ? {valid: true, ypath: [it], status: 200}
    : handleItPath(it, sessionID, xpath);
}

// Root required, but caller is not root : Signal forbidden // Unknown access protocol : Signal forbidden
function forbidden (it, sessionID) {
  return it['_access'] === 'root' && sessionID !== 1;
}

function hasEllipsis (it) {
  return it.hasOwnProperty('_ellipsis') && it['_ellipsis'] === true;
}

function handleItPath (it, sessionID, xpath) {
  const ypath = [];
  for (let i = 0, len = xpath.length; i < len; ++i) {
    let flagFoundRef = false;
    ypath.push(it);
    if (it !== null && typeof it === 'object') {
      if (forbidden(it, sessionID)) return {valid: false, node: it, ypath, status: 403};

      let ellipsis = hasEllipsis(it);

      if (it.hasOwnProperty('_ref')) { // Next xpath node is part of a dynamic list
        if (hasEllipsis(it['_ref'])) ellipsis = true;

        if (!it['_ref'].hasOwnProperty('_list')) { // List not found
          return ellipsis
            ? {valid: true, ypath: [it], node: it, status: 200}
            : {valid: false, ypath, status: 500, msg: 'Missing list describer for references.'};
        }

        flagFoundRef = isValidRef(it['_ref'], xpath[i], sessionID);

        if (flagFoundRef) {
          it = it['_ref'];
          if (forbidden(it, sessionID)) return {valid: false, node: it, ypath, status: 403};
          ypath[ypath.length - 1] = it;
        }
      }

      if (!flagFoundRef) { // If no reference list is found, try explicit nodes
        const itOrError = getExplicitNodeOrReturnError(it, xpath, ypath, i, sessionID);
        if (itOrError.valid === true) return itOrError;
        else if (itOrError.valid === false) {
          return (ellipsis && itOrError.status === 404)
            ? {valid: true, ypath: [it], node: it, status: 200}
            : itOrError;
        } else it = itOrError;
      }
    } else if (i < len - 1) return {valid: false, ypath, status: 404}; // Not an object so can't find a next xpath node
  }
  return handleItTypes(it, xpath, ypath, sessionID);
}

function handleItTypes (it, xpath, ypath, sessionID) {
  if (typeof it === 'string') return {valid: true, ypath: ypath, node: it, status: 200};
  else if (forbidden(it, sessionID)) return {valid: false, ypath, node: it, status: 403};
  else if (it !== null && typeof it === 'object') {
    return it.hasOwnProperty('_this') && ypath.length === xpath.length
      ? {valid: true, ypath: ypath, node: it, status: 200}
      : {valid: false, ypath: ypath, status: 404};
  } else return {valid: false, ypath: ypath, status: 500}; // the routes.json itself is invalid
}

function getExplicitNodeOrReturnError (it, xpath, ypath, i, sessionID) {
  return it.hasOwnProperty(xpath[i])
    ? updateItOrError_(it, xpath, ypath, i, sessionID)
    : {valid: false, ypath: ypath, status: 404}; // Can't find next xpath node
}

function updateItOrError_ (it, xpath, ypath, i, sessionID) {
  const hasAlias = it[xpath[i]] !== null && typeof it[xpath[i]] === 'object' && it[xpath[i]].hasOwnProperty('_alias');
  return hasAlias
    ? updateItOrError(it, xpath, ypath, i, sessionID)
    : it[xpath[i]]; // Found next xpath node, moving to it
}

function updateItOrError (it, xpath, ypath, i, sessionID) {
  const alias = it[xpath[i]]['_alias'];
  if (alias === '/') {
    xpath.splice(0, i + 1);
    return isValidPath(xpath, sessionID);
  } else if (it.hasOwnProperty(alias)) {
    const newIt = it[it[xpath[i]]['_alias']];
    xpath[i] = it[xpath[i]]['_alias']; // update xpath with alias
    return newIt;
  } else {
    return {valid: false, ypath: ypath, status: 500, msg: "Alias '" + xpath[i] + "' => '" + it[xpath[i]]['_alias'] + "'not found"}; // Alias not found
  }
}

// routing handler
function route (request) {
  return typeof request.url === 'string'
    ? handleRequest(request)
    : {error: 400, data: 'Your request was ill formatted. Expected request url to be a string'};
}

function showRequestInLogs (xpath, request) {
  const routedPath = request.url;
  if (xpath[1] === 'web-wallet' && xpath[2] === 'api') return showRequestInLogs(xpath.slice(3), request); // also hide web wallet api y,p and z calls
  return xpath[0] !== 'y' && !(xpath[0] === 'p' && xpath[0] !== 'debug') && xpath[0] !== 'z' && routedPath !== lastRoutedPath && request.hideInLogs !== true;
}

function checkSessionUpgrade (request, xpath) {
  if (request.sessionID !== 1 && request.headers && request.headers.hasOwnProperty('private-token')) {
    const storedPrivateToken = conf.get('host.private-token');
    if (typeof storedPrivateToken === 'string') {
      const receivedPrivateToken = request.headers['private-token'];
      if (storedPrivateToken === receivedPrivateToken) request.sessionID = 1;
      else global.hybrixd.logger(['error', 'router'], 'Illegal session upgrade attempt for /' + xpath.join('/'));
    }
  }
}

function handleRequest (request) {
  const routedPath = request.url;
  let xpath = cleanPath(routedPath.split('/'), request); // create xpath array
  if (xpath.length === 0) xpath = ['help'];// default to /help

  const shorthand = typeof xpath[0] === 'undefined' || xpath[0].length <= 1;

  // route path handling (log only feedbacks same route once and stay silent for y and z calls )
  if (showRequestInLogs(xpath, request)) {
    let uri = xpath.join('/');
    if (uri.length > MAX_ROUTER_PATH_LOG_LENGTH) { // reduce length of too long uri requests
      uri = uri.substr(0, MAX_ROUTER_PATH_LOG_LENGTH * 0.5) + '...' + uri.substr(-MAX_ROUTER_PATH_LOG_LENGTH * 0.5);
    }
    global.hybrixd.logger(['info', 'router'], 'Routing request /' + uri);
  }

  lastRoutedPath = routedPath; // used to prevent double log on repeated calls

  checkSessionUpgrade(request, xpath);

  // routing logic starts here
  const meta = isValidPath(xpath, request.sessionID);
  return !meta.valid
    ? logAndReturnHelp(xpath, meta) // return error and help message
    : getFinalResult(request, xpath, shorthand, meta); // return result
}

function cleanPath (xpath, request) {
  for (let i = 0; i < xpath.length; i++) {
    if (xpath[i] === '') {
      xpath.splice(i, 1); i--;
    } else {
      try {
        xpath[i] = decodeURIComponent(xpath[i]); // prune empty values and clean vars
      } catch (e) {
        global.hybrixd.logger(['error', 'router'], 'Illegal routing url: ' + request.url);
        return xpath; // Default to help;
      }
    }
  }

  return xpath;
}

// updates the result.data in case the _ui property is specified for this call. The html data will be updated to include the ui scripts and css
function handleUiResult (result, meta) {
  if (typeof meta !== 'object' || meta === null) return;
  if (typeof meta.node !== 'object' || meta.node === null) return;
  if (!meta.node.hasOwnProperty('_ui')) return;

  if (result.error !== 0) return;

  if (typeof result.data !== 'string' && !(result.data instanceof Buffer)) return;
  result.data = result.data.toString('utf8').replace(/<head>/i, `<head>${dynamicallyLoadUiScript}`);
}

function getFinalResult (request, xpath, shorthand, meta) {
  let result = getNode(request, xpath);

  if (typeof result === 'object' && result !== null) { // flat files
    let offset = request.offset || result.offset;
    let length = request.length || result.length;
    let hash = request.hash || result.hash;

    if (typeof offset !== 'undefined' && typeof length !== 'undefined') {
      result = checkFileResult(result, offset, length, request);
    } else if (typeof result.mime === 'string' && result.mime.startsWith('file:')) { // a file without  offset and length => delete result['file'];
      if (!hash && ((result.hasOwnProperty('stopped') && result.stopped === null) || result.error !== 0)) { // clear type if there's an error or if not yet stopped
        delete result.mime;
      } else if (typeof result.data !== 'string') {
        result = fileNotFoundResult(result);
      } else {
        result = handleFileRequest(result, hash);
      }
    }
  }

  if (typeof result !== 'object' || result === null) {
    global.hybrixd.logger(['error', 'router'], 'Routing error for /' + xpath.join('/'), result);
    result = {error: 500};
  }

  handleUiResult(result, meta);

  if (typeof result.path === 'undefined') {
    result.path = xpath;
  }
  if (result.path instanceof Array) {
    result.path = '/' + result.path.join('/'); // format the path back to string ["asset","dummy"] => "asset/dummy"
  }
  // when shorthand is used, cull output data
  if (shorthand) {
    delete result.command;
    delete result.help;
    delete result.path;
  }
  delete result.noCache;
  return result;
}

// /* Result should be one of the following
//      - A string containging encrypted ychan data or compressed zchan data
//      - A result data object containing:
//      - - error
//      - - data
//      - - path
//      - - command
//      - - [id]
//      - - [type]  'file' 'html'
//   */

function handleFileRequest (result, hash) {
  const filePath = '../' + result.data.replace('..', ''); // 'file://*' => file : '$HYBRIXD_HOME/*'   //TODO Make safer MAYBE warning on '..' usage?
  if (!fs.existsSync(filePath)) {
    result = fileNotFoundResult(result);
  } else {
    const stats = fs.statSync(filePath);
    if (stats.isFile()) {
      if (hash) {
        result = checkHashResult(result, filePath);
      } else {
        result = checkFileData(result, filePath);
      }
    } else {
      result = fileNotFoundResult(result);
    }
  }
  return result;
}

function fileNotFoundResult (result) {
  delete result.mime;
  result.error = 404;
  global.hybrixd.logger(['error', 'router'], 'File not found', result.data);
  result.data = 'File not found.';
  return result;
}

function checkHashResult (result, filePath) {
  if (!fileHashes.hasOwnProperty(filePath)) {
    fileHashes[filePath] = DJB2.hash(String(fs.readFileSync(filePath).toString('utf8')));
  }
  result.data = fileHashes[filePath];
  delete result.mime;

  return result;
}

function checkFileData (result, filePath) {
  result.data = fs.readFileSync(filePath);// .toString('utf8');
  if (typeof result.mime === 'string') {
    result.mime = result.mime.substr(5); // "file:$CONTENT-TYPE" =>  "$CONTENT-TYPE"
  }
  if ((typeof result.mime === 'undefined' || result.mime === 'data') && result.data instanceof Buffer) {
    result.data = result.data.toString('utf8');
  }

  if (result.mime === 'data') { // remove default
    delete result.mime;
  }

  return result;
}

function getFileResult (result, filePath, offset, length, request) {
  if (fs.existsSync(filePath)) {
    result = getPartialData(result, length, offset, filePath);
    if (request.offset && request.length) {
      result.path = ['wchan', offset, length].concat(result.path);
    }
    return result;
  } else {
    global.hybrixd.logger(['error', 'router'], 'File not found', filePath);
    return {
      err: 1,
      data: 'File not found.'
    };
  }
}

function checkFileResult (result, offset, length, request) {
  if (typeof result.mime === 'string' && result.mime.startsWith('file:')) {
    let filePath = '../' + result.data.replace('..', ''); // 'file://*' => file : '$HYBRIXD_HOME/*'   //TODO Make safer MAYBE warning on '..' usage?
    result = Object.assign(result, getFileResult(result, filePath, offset, length, request));
  } else { // a non file with offset && length : remove the options, no pagination for those
    delete result['length'];
    delete result['offset'];
  }
  return result;
}

function renderStatus (status) {
  if (status === 403) return status + ' Forbidden';
  if (status === 404) return status + ' Not found';
  if (status === 400) return status + ' Bad request';
  if (status === 500) return status + ' Server error';
  return status + ' Error';
}

function logAndReturnHelp (xpath, meta) {
  global.hybrixd.logger(['error', 'router'], 'Illegal routing request: /' + xpath.join('/'));

  if (typeof meta === 'object' && meta !== null && meta.hasOwnProperty('node') &&
     typeof meta.node === 'object' && meta.node !== null &&
      meta.node.hasOwnProperty('_ui')) {
    return {mime: 'text/html', data: `<html><head>${dynamicallyLoadUiScript}</head><body><h1>${renderStatus(meta.status)}</h1>${help.help(xpath, meta)}</body></html>`, error: meta.status, id: null, path: '/' + xpath.join('/')};
  } else {
    return {help: help.help(xpath, meta), error: meta.status, id: null, path: '/' + xpath.join('/')};
  }
}

function getPartialData (result, length, offset, filePath) {
  // use a offset and length to return partial data
  const buffer = Buffer.alloc(length);
  const fileStream = fs.openSync(filePath, 'r');
  fs.readSync(fileStream, buffer, 0, length, offset);
  fs.closeSync(fileStream);
  result.mime = result.mime.substr(5); // "file:$CONTENT-TYPE" =>  "$CONTENT-TYPE"
  result.data = buffer.toString('utf8');
  result.offset = offset;
  result.length = length;

  return result;
}

function getNode (request, xpath) {
  const isAliasDefined = global.hybrixd.routetree.hasOwnProperty(xpath[0]) &&
        global.hybrixd.routetree[xpath[0]].hasOwnProperty('_alias') && // Check for alias in routeTree
        routeRootMap.hasOwnProperty(global.hybrixd.routetree[xpath[0]]['_alias']);

  const aliasOrNull = isAliasDefined ? global.hybrixd.routetree[xpath[0]]['_alias'] : null;
  const node = routeRootMap.hasOwnProperty(xpath[0]) ? xpath[0] : aliasOrNull;

  return node !== null
    ? routeRootMap[node](request, xpath)
    : {error: 400, data: 'Your request was not understood!'}; // default error message
}

exports.route = route;
exports.isValidPath = isValidPath;
exports.isValidRef = isValidRef;
exports.refList = refList;

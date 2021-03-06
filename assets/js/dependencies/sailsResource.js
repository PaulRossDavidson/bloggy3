(function (angular) {

  var forEach = angular.forEach,
    copy = angular.copy,
    extend = angular.extend,
    isObject = angular.isObject,
    isArray = angular.isArray,
    isString = angular.isString,
    isFunction = angular.isFunction;

  angular.module('sailsResource', []).provider('sailsResource', function () {

    var DEFAULT_CONFIGURATION = {
      // Set a route prefix, such as '/api'
      prefix: '',
      // When verbose, socket updates go to the console
      verbose: false,
      // Set a specific websocket
      socket: null,
      // Set a specific origin
      origin: null,
      // Set resource primary key
      primaryKey: 'id'
    };

    this.configuration = {};

    this.$get = ['$rootScope', '$window', '$log', '$q', function ($rootScope, $window, $log, $q) {
      var config = extend({}, DEFAULT_CONFIGURATION, this.configuration);
      return resourceFactory($rootScope, $window, $log, $q, config);
    }];
  });

  function resourceFactory($rootScope, $window, $log, $q, config) {

    var DEFAULT_ACTIONS = {
      'get': {method: 'GET'},
      'save': {method: 'POST'},
      'query': {method: 'GET', isArray: true},
      'remove': {method: 'DELETE'},
      'delete': {method: 'DELETE'}
    };

    var MESSAGES = {
      // Resource
      created: '$sailsResourceCreated',
      updated: '$sailsResourceUpdated',
      destroyed: '$sailsResourceDestroyed',
      messaged: '$sailsResourceMessaged',
      addedTo : '$sailsResourceAddedTo',
      removedFrom : '$sailsResourceRemovedFrom',


      // Socket
      connected: '$sailsConnected',
      disconnected: '$sailsDisconnected',
      reconnected: '$sailsReconnected',
      reconnecting: '$sailsReconnecting',
      socketError: '$sailsSocketError'
    };

    return function (model, actions, options) {

      if (typeof model != 'string' || model.length == 0) {
        throw 'Model name is required';
      }

      model = model.toLowerCase(); // Sails always sends models lowercase
      actions = extend({}, DEFAULT_ACTIONS, actions);
      options = extend({}, config, options);

      // Ensure prefix starts with forward slash
      if (options.prefix && options.prefix.charAt(0) != '/') {
        options.prefix = '/' + options.prefix;
      }

      // Create our socket instance based on options

      var socket;
      if(options.socket) { // Was given to us
        socket = options.socket;
      }
      else if(options.origin) { // A custom origin
        socket = $window.io.sails.connect(options.origin);
      }
      else { // Default: use base socket
        socket = $window.io.socket;
      }

      // Setup socket default messages

      socket.on('connect', function () {
        $rootScope.$evalAsync(function () {
          $rootScope.$broadcast(MESSAGES.connected);
        });
      });

      socket.on('disconnect', function () {
        $rootScope.$evalAsync(function () {
          $rootScope.$broadcast(MESSAGES.disconnected);
        });
      });

      socket.on('reconnect', function () {
        $rootScope.$evalAsync(function () {
          $rootScope.$broadcast(MESSAGES.reconnected);
        });
      });

      socket.on('reconnecting', function (timeDisconnected, reconnectCount) {
        $rootScope.$evalAsync(function () {
          $rootScope.$broadcast(MESSAGES.reconnecting, {
            timeDisconnected: timeDisconnected,
            reconnectCount: reconnectCount
          });
        });
      });

      socket.on('error', function (error) {
        $rootScope.$evalAsync(function () {
          $rootScope.$broadcast(MESSAGES.socketError, error);
        });
      });

      // Disconnect socket when window unloads
      $window.onbeforeunload = function () {
        if (socket) {
          socket.disconnect();
        }
      };

      // Caching
      var cache = {};
      // TODO implement cache clearing?

      function removeFromCache(id) {
        delete cache[id];
        // remove this item in all known lists
        forEach(cache, function (cacheItem) {
          if (isArray(cacheItem)) {
            var foundIndex = null;
            forEach(cacheItem, function (item, index) {
              if (item[options.primaryKey] == id) {
                foundIndex = index;
              }
            });
            if (foundIndex != null) {
              cacheItem.splice(foundIndex, 1);
            }
          }
        });
      }

      // Resource constructor
      function Resource(value) {
        copy(value || {}, this);
      }

      function mergeParams(params, actionParams) {
        return extend({}, actionParams || {}, params || {});
      }

      // Handle a request
      // Does a small amount of preparation of data and directs to the appropriate request handler
      function handleRequest(item, params, action, success, error) {

        // When params is a function, it's actually a callback and no params were provided
        if (isFunction(params)) {
          error = success;
          success = params;
          params = {};
        }


        var instanceParams,
          actionParams = action && typeof action.params === 'object' ? action.params : {};
        if (action.method == 'GET') {

          instanceParams = mergeParams(params, actionParams);

          // Do not cache if:
          // 1) action is set to cache=false (the default is true) OR
          // 2) action uses a custom url (Sails only sends updates to ids) OR
          // 3) the resource is an individual item without an id (Sails only sends updates to ids)

          if (!action.cache || action.url || (!action.isArray && (!instanceParams || !instanceParams[options.primaryKey]))) { // uncached
            item = action.isArray ? [] : new Resource();
          }
          else {
            // cache key is 1) stringified params for lists or 2) id for individual items
            var key = action.isArray ? JSON.stringify(instanceParams || {}) : instanceParams[options.primaryKey];
            // pull out of cache if available, otherwise create new instance
            item = cache[key] || (action.isArray ? []
                // Set key on object using options.primaryKey
                : (function(){ var tmp = {}; tmp[options.primaryKey] = key; return new Resource(tmp) })());
            cache[key] = item; // store item in cache
          }

          return retrieveResource(item, instanceParams, action, success, error);
        }
        else {
          // When we have no item, params is assumed to be the item data
          if (!item) {
            item = new Resource(params);
            params = {};
          }

          instanceParams = mergeParams(params, actionParams);

          if (action.method == 'POST' || action.method == 'PUT') { // Update individual instance of model
            return createOrUpdateResource(item, instanceParams, action, success, error);
          }
          else if (action.method == 'DELETE') { // Delete individual instance of model
            return deleteResource(item, instanceParams, action, success, error);
          }
        }
      }

      // Handle a response
      function handleResponse(item, data, action, deferred, delegate) {
        action = action || {};
        $rootScope.$evalAsync(function () {
          item.$resolved = true;

          if (data && (data.error || data.statusCode > 400)) {
            // $log.error(data);
            deferred.reject(data || data, item, data);
          }
          else if (!isArray(item) && isArray(data) && data.length != 1) {
            // This scenario occurs when GET is done without an id and Sails returns an array. Since the cached
            // item is not an array, only one item should be found or an error is thrown.
            var errorMessage = (data.length ? 'Multiple' : 'No') +
              ' items found while performing GET on a singular \'' + model + '\' Resource; did you mean to do a query?';

            // $log.error(errorMessage);
            deferred.reject(errorMessage, item, data);
          }
          else {
            // converting single array to single item
            if (!isArray(item) && isArray(data)) data = data[0];

            if (isArray(action.transformResponse)) {
              forEach(action.transformResponse, function(transformResponse) {
                if (isFunction(transformResponse)) {
                  data = transformResponse(data);
                }
              })
            }
            if (isFunction(action.transformResponse)) data = action.transformResponse(data);
            if (isFunction(delegate)) delegate(data);

            // 1) Internally resolve with both item and header getter
            // for pass'em to explicit success handler
            // 2) In attachPromise() cut off header getter, so that
            // implicit success handlers receive only item
            deferred.resolve({
              item: item,
              getHeaderFn: function(name) { return jwr && jwr.headers && jwr.headers[name]; }
            });
          }
        });
      }

      function attachPromise(item, success, error) {
        var deferred = $q.defer();

        item.$promise = deferred.promise.then(function(result) {
          // Like in ngResource explicit success handler
          // (passed directly as an argument of action call)
          // receives two arguments:
          // 1) item and 2) header getter function.
          (success || angular.noop)(result.item, result.getHeaderFn);

          // Implicit success handlers (bound via Promise API, .then())
          // receive only item argument
          return $q.when(result.item);
        });
        item.$promise.catch(error);
        item.$resolved = false;
        return deferred;
      }

      // Request handler function for GETs
      function retrieveResource(item, params, action, success, error) {
        var deferred = attachPromise(item, success, error);

        var url = buildUrl(model, params ? params[options.primaryKey] : null, action, params, options);
        item.$retrieveUrl = url;

        if (options.verbose) {
          $log.info('sailsResource calling GET ' + url);
        }

        socket.get(url, function (response) {
          handleResponse(item, response, action, deferred, function (data) {
            if (isArray(item)) { // empty the list and update with returned data
              while (item.length) item.pop();
              forEach(data, function (responseItem) {
                responseItem = new Resource(responseItem);
                responseItem.$resolved = true;
                item.push(responseItem); // update list
              });
            }
            else {
              extend(item, data); // update item

              // If item is not in the cache based on its id, add it now
              if (!cache[ item[ options.primaryKey ] ]) {
                cache[ item[ options.primaryKey ] ] = item;
              }
            }
          });
        });
        return item.$promise;
      }

      // Request handler function for PUTs and POSTs
      function createOrUpdateResource(item, params, action, success, error) {
        var deferred = attachPromise(item, success, error);

        // prep data
        var transformedData;
        if (isFunction(action.transformRequest)) {
          var tmp = action.transformRequest(item);
          transformedData = typeof tmp === 'object' ? tmp : JSON.parse(tmp);
        }

        // prevents prototype functions being sent
        var data = copyAndClear(transformedData || item, {});

        var url = buildUrl(model, data[options.primaryKey], action, params, options);

        // when Resource has id use PUT, otherwise use POST
        var method = item[options.primaryKey] ? 'put' : 'post';

        if (options.verbose) {
          $log.info('sailsResource calling ' + method.toUpperCase() + ' ' + url);
        }

        socket[method](url, data, function (response) {
          handleResponse(item, response, action, deferred, function (data) {
            extend(item, data);

            var message = {
              model: model,
              data: item
            };
            message[options.primaryKey] = item[options.primaryKey];

            if (method === 'put') {
              // Update cache
              socketUpdateResource(message);
              // Emit event
              $rootScope.$broadcast(MESSAGES.updated, message);
            } else {
              // Update cache
              socketCreateResource(message);
              // Emit event
              $rootScope.$broadcast(MESSAGES.created, message);
            }
          });
        });

        return item.$promise;
      }

      // Request handler function for DELETEs
      function deleteResource(item, params, action, success, error) {
        var deferred = attachPromise(item, success, error);
        var url = buildUrl(model, item[options.primaryKey], action, params, options);

        if (options.verbose) {
          $log.info('sailsResource calling DELETE ' + url);
        }
        socket.delete(url, function (response) {
          handleResponse(item, response, action, deferred, function () {
            removeFromCache(item[options.primaryKey]);
            var tmp = {model: model};
            tmp[options.primaryKey] = item[options.primaryKey];
            $rootScope.$broadcast(MESSAGES.destroyed, tmp);
            // leave local instance unmodified
          });
        });

        return item.$promise;
      }

      function socketUpdateResource(message) {
        forEach(cache, function (cacheItem, key) {
          if (isArray(cacheItem)) {
            forEach(cacheItem, function (item) {
              if (item[options.primaryKey] == message[options.primaryKey]) {
                if (needsPopulate(message.data, item)) { // go to server for updated data
                  var tmp = {};
                  tmp[options.primaryKey] = item[options.primaryKey];
                  retrieveResource(item, tmp);
                }
                else {
                  extend(item, message.data);
                }
              }
            });
          }
          else if (key == message[options.primaryKey]) {
            if (needsPopulate(message.data, cacheItem)) { // go to server for updated data
              var tmp = {};
              tmp[options.primaryKey] = cacheItem[options.primaryKey];
              retrieveResource(cacheItem, tmp);
            }
            else {
              extend(cacheItem, message.data);
            }
          }
        });
      }

      function socketCreateResource(message) {
        cache[message[options.primaryKey]] = new Resource(message.data);
        // when a new item is created we have no way of knowing if it belongs in a cached list,
        // this necessitates doing a server fetch on all known lists
        // TODO does this make sense?
        forEach(cache, function (cacheItem, key) {
          if (isArray(cacheItem)) {
            retrieveResource(cacheItem, JSON.parse(key));
          }
        });
      }

      function socketDeleteResource(message) {
        removeFromCache(message[options.primaryKey]);
      }

      // Add each action to the Resource and/or its prototype
      forEach(actions, function (action, name) {
        // fill in default action options
        action = extend({}, {cache: true, isArray: false}, action);

        function actionMethod(params, success, error) {
          var self = this;
          if (action.fetchAfterReconnect) {
            // let angular-resource-sails refetch important data after
            // a server disconnect then reconnect happens
            socket.on('reconnect', function () {
              handleRequest(isObject(self) ? self : null, params, action, success, error);
            });
          }

          return handleRequest(isObject(this) ? this : null, params, action, success, error);
        }

        if (/^(POST|PUT|PATCH|DELETE)$/i.test(action.method)) {
          // Add to instance methods to prototype with $ prefix, GET methods not included
          Resource.prototype['$' + name] = actionMethod;
        }

        // All method types added to service without $ prefix
        Resource[name] = actionMethod;
      });

      // Handy function for converting a Resource into plain JSON data
      Resource.prototype.toJSON = function() {
        var data = extend({}, this);
        delete data.$promise;
        delete data.$resolved;
        return data;
      };

      // Subscribe to changes
      socket.on(model, function (message) {
        if (options.verbose) {
          $log.info('sailsResource received \'' + model + '\' message: ', message);
        }
        var messageName = null;
        $rootScope.$evalAsync(function () {
          switch (message.verb) {
            case 'updated':
              socketUpdateResource(message);
              messageName = MESSAGES.updated;
              break;
            case 'created':
              socketCreateResource(message);
              messageName = MESSAGES.created;
              break;
            case 'destroyed':
              socketDeleteResource(message);
              messageName = MESSAGES.destroyed;
              break;
            case 'messaged':
              messageName = MESSAGES.messaged;
              break;
            case 'addedTo' :
              messageName = MESSAGES.addedTo;
              break;
            case 'removedFrom' :
              messageName = MESSAGES.removedFrom;
              break;
          }
          $rootScope.$broadcast(messageName, extend({model: model}, message));
        });
      });

      return Resource;
    };
  }

  /**
   * As of Sails 0.10.4 models with associations will not be populated in socket update data. This function detects
   * this scenario, i.e. the dst[key] (current value) is an object, but the src[key] (updated value) is an id.
   * Ideally this function will stop returning true if/when Sails addresses this issue as both dst and src will
   * contain an object.
   */
  function needsPopulate(src, dst) {
    for (var key in src) {
      if (src.hasOwnProperty(key) && isObject(dst[key]) && !isObject(src[key])) {
        return true;
      }
    }
    return false;
  }

  /**
   * Deep copies and removes view properties
   */
  function copyAndClear(src, dst) {
    dst = dst || (isArray(src) ? [] : {});

    forEach(dst, function (value, key) {
      delete dst[key];
    });

    for (var key in src) {
      if (src.hasOwnProperty(key) && key.charAt(0) !== '$') {
        var prop = src[key];
        dst[key] = isObject(prop) ? copyAndClear(prop) : prop;
      }
    }

    return dst;
  }

  /**
   * Builds a sails URL!
   */
  function buildUrl(model, id, action, params, options) {
    var url = [];
    var urlParams = {};

    if (action && action.url) {
      var actionUrl = action.url;

      // Look for :params in url and replace with params we have
      var matches = action.url.match(/(:\w+)/g);
      if (matches) {
        forEach(matches, function (match) {
          var paramName = match.replace(':', '');
          if (paramName === options.primaryKey) {
            actionUrl = actionUrl.replace(match, id);
          } else {
            urlParams[paramName] = true;
            actionUrl = actionUrl.replace(match, params[paramName]);
          }
        });
      }

      url.push(actionUrl);
    }
    else {
      url.push(options.prefix);
      url.push('/');
      url.push(model);
      if (id) url.push('/' + id);
    }

    var queryParams = {};
    angular.forEach(params, function(value, key) {
      if (!urlParams[key]) {
        queryParams[key] = value;
      }
    });

    url.push(createQueryString(queryParams, options));
    return url.join('');
  }

  /**
   * Create a query-string out of a set of parameters, similar to way AngularJS does (as of 1.3.15)
   * @see https://github.com/angular/angular.js/commit/6c8464ad14dd308349f632245c1a064c9aae242a#diff-748e0a1e1a7db3458d5f95d59d7e16c9L1142
   */
  function createQueryString(params) {
    if (!params) { return ''; }

    var parts = [];
    Object.keys(params).sort().forEach(function(key) {
      var value = params[key];
      if (key === 'id') { return; }
      if (value === null || value === undefined) { return; }
      if (!Array.isArray(value)) { value = [value]; }
      value.forEach(function(v) {
        if (angular.isObject(v)) {
          v = angular.isDate(v) ? v.toISOString() : angular.toJson(v);
        }
        parts.push(key + '=' + v);
      });
    });
    return parts.length ? '?' + parts.join('&') : '';
  }


})(window.angular);

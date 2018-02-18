"use strict";
var _ = {
  omitBy: require("lodash.omitby")
};
var async = require("async");
var debug = require("debug")("jsonApi:store:firebase");
var firebase = require("firebase-admin");
var Joi = require("joi");
var semver = require("semver");

var MIN_SERVER_VERSION = "1.10.0";

var FirebaseStore = function FirebaseStore(config) {
  FirebaseStore._checkMinServerVersion();
  this._config = config;
  this.firebaseApp = null;
};

module.exports = FirebaseStore;

/**
  Handlers readiness status. This should be set to `true` once all handlers are ready to process requests.
 */
FirebaseStore.prototype.ready = false;


FirebaseStore._checkMinServerVersion = function() {
  var serverVersion = require('jsonapi-server')._version;
  if (!serverVersion) return;
  if (semver.lt(serverVersion, MIN_SERVER_VERSION)) {
    throw new Error("This version of jsonapi-store-firebase requires jsonapi-server>=" + MIN_SERVER_VERSION + ".");
  }
};

FirebaseStore._isRelationshipAttribute = function(attribute) {
  return attribute._settings && (attribute._settings.__one || attribute._settings.__many);
};

FirebaseStore._assignAttributeNames = function(resourceConfig) {
  resourceConfig.relationshipAttributeNames = []
  resourceConfig.attributeNames = []

  Object.getOwnPropertyNames(resourceConfig.attributes).forEach(
    attributeName => {
      const attribute = resourceConfig.attributes[attributeName]
      if (FirebaseStore._isRelationshipAttribute(attribute)) {
        resourceConfig.relationshipAttributeNames.push(attributeName)
      } else {
        resourceConfig.attributeNames.push(attributeName)
      }
    }
  )
};

FirebaseStore._notFoundError = function(type, id) {
  return {
    status: "404",
    code: "ENOTFOUND",
    title: "Requested resource does not exist",
    detail: "There is no " + type + " with id " + id
  };
};

FirebaseStore._unknownError = function(err) {
  return {
    status: "500",
    code: "EUNKNOWN",
    title: "An unknown error has occured",
    detail: err
  };
};

FirebaseStore._toFirebase = function(resourceConfig, rawData) {
  if (!resourceConfig.relationshipAttributeNames) {
    FirebaseStore._assignAttributeNames(resourceConfig)
  }
  const document = _.omitBy(rawData, (value) => value === undefined );
  resourceConfig.relationshipAttributeNames.forEach(
    attributeName => {
      const value     = rawData[attributeName]
      const attribute = resourceConfig.attributes[attributeName]
      if (value) {
        if (attribute._settings.__one) {
          document[attributeName] = value.id
        } else if (attribute._settings.__many) {
          const newValue = {}
          document[attributeName].forEach(
            v => newValue[v.id] = true
          )
          document[attributeName] = newValue
        }
      }
    }
	)
	delete document.type
	delete document.id
	delete document.meta
  return document
}

FirebaseStore._fromFirebase= function(resourceConfig, snapShot) {
	// convert all relationship
	const rawData = snapShot.val()
	rawData.id = snapShot.ref.key
  rawData.type = resourceConfig.resource

  Object.getOwnPropertyNames(rawData).forEach(
    (attributeName) => {
      const attribute = resourceConfig.attributes[attributeName]
      if (attribute) {
        const value = rawData[attributeName]
        if (value && attribute._settings) {
          if (attribute._settings.__one) {
            rawData[attributeName] = {
              id:value,
              type:attribute._settings.__one[0]
            }
          } else if (attribute._settings.__many) {
            const type = attribute._settings.__many[0]
            rawData[attributeName] = Object.keys(value).map( id => ({
              type,
              id
            }))
          }
        }
      } else {
        delete rawData[attributeName]
      }
    }
  )

  return rawData
}

/**
  Initialise gets invoked once for each resource that uses this handler.
 */
FirebaseStore.prototype.initialise = function(resourceConfig) {
  if (!this._config.serviceAccount) {
    return console.error("Firebase service account missing from configuration");
  }
  if (!this._config.databaseName) {
    return console.error("Firebase database name missing from configuration");
  }

  FirebaseStore._assignAttributeNames(resourceConfig);

  const appName = `jsonapi-store-firebase-${this._config.databaseName}`
	try {
		this.firebaseApp = firebase.app(appName)
	} catch(e) {
		this.firebaseApp = firebase.initializeApp({
			credential: firebase.credential.cert(this._config.serviceAccount),
			databaseURL: `https://${this._config.databaseName}.firebaseio.com`
    },
    appName)
	}
  this.ready = true
};

/**
  Search for a list of resources, give a resource type.
 */
FirebaseStore.prototype.search = function(request, callback) {
	const ref = this.firebaseApp.database().ref(request.params.type)
	// TODO : implement paging on query, and filtering
	ref.orderByKey().once("value").then(
		(dataSnapShot) => {
			const resultSet = []

			dataSnapShot.forEach(
				snapShot => {
					resultSet.push(FirebaseStore._fromFirebase(request.resourceConfig, snapShot))
				}
			)
			return callback(null, resultSet, resultSet.length);
		}
  ).catch(
    e => callback(
      FirebaseStore._unknownError(e)
    )
  )
};

/**
  Find a specific resource, given a resource type and and id.
 */
FirebaseStore.prototype.find = function(request, callback) {
  const ref = this.firebaseApp.database().ref(`${request.params.type}/${request.params.id}`)

  return ref.once("value").then(
    dataSnapShot => {
      if (dataSnapShot.exists()) {
        return callback(null,
          FirebaseStore._fromFirebase(request.resourceConfig, dataSnapShot)
        )
      } else {
        return callback(
          FirebaseStore._notFoundError(request.params.type, request.params.id)
        );
      }
    }
  ).catch(
    e => callback(
      FirebaseStore._unknownError(e)
    )
  )
};



/**
  Create (store) a new resource give a resource type and an object.
 */
FirebaseStore.prototype.create = function(request, newResource, callback) {
  const ref = this.firebaseApp.database().ref(`${request.params.type}`);
  const newRef = ref.push();
  const document = FirebaseStore._toFirebase(request.resourceConfig, newResource)
	newResource.id = newRef.key

  return newRef.set(document).then(
    () => callback(null, newResource)
  ).catch(
    e => callback(
      FirebaseStore._unknownError(e)
    )
  )
};


/**
  Delete a resource, given a resource type and an id.
 */
FirebaseStore.prototype.delete = function(request, callback) {
  const ref = this.firebaseApp.database().ref(`${request.params.type}/${request.params.id}`);
  ref.remove().then(
    () => callback()
  ).catch(
    e => callback(
      FirebaseStore._unknownError(e)
    )
  )
};


/**
  Update a resource, given a resource type and id, along with a partialResource.
  partialResource contains a subset of changes that need to be merged over the original.
 */
FirebaseStore.prototype.update = function(request, partialResource, callback) {
  const ref = this.firebaseApp.database().ref(`${request.params.type}/${request.params.id}`);
  const partialDocument = FirebaseStore._toFirebase(request.resourceConfig, partialResource)

  ref.update(partialDocument).then(
    () => callback(null, partialResource)
  ).catch(
    e => callback(
      FirebaseStore._unknownError(e)
    )
  )
};

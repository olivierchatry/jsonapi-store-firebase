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
  this.resourceConfig  = null;
  this.relationshipAttributeNames = null;
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



FirebaseStore._getRelationshipAttributeNames = function(attributes) {
  var attributeNames = Object.getOwnPropertyNames(attributes);
  var relationshipAttributeNames = attributeNames.reduce(function(partialAttributeNames, name) {
    var attribute = attributes[name];
    if (FirebaseStore._isRelationshipAttribute(attribute)) {
      return partialAttributeNames.concat(name);
    }
    return partialAttributeNames;
  }, []);
  return relationshipAttributeNames;
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
  this.resourceConfig = resourceConfig;
	this.relationshipAttributeNames = FirebaseStore._getRelationshipAttributeNames(resourceConfig.attributes);
	try {
		this.firebaseApp = firebase.app()
	} catch(e) {
		this.firebaseApp = firebase.initializeApp({
			credential: firebase.credential.cert(this._config.serviceAccount),
			databaseURL: `https://${this._config.databaseName}.firebaseio.com`
		})
	}
  const resourceName = resourceConfig.resource;
  this.ready = true
};


/**
  Drops the database if it already exists and populates it with example documents.
 */
FirebaseStore.prototype.populate = function(callback) {
  const firebaseRef = this.firebaseApp.database().ref()
	firebaseRef.set(null).then(
    () => {
      async.each(this.resourceConfig.examples, (document, cb) => {
        var validationResult = Joi.validate(document, this.resourceConfig.attributes);
        if (validationResult.error) {
          return cb(validationResult.error);
        }
        this.create({ params: {} }, validationResult.value, cb);
      }, function(error) {
        if (error) console.error("error creating example document:", error);
        return callback();
      });
    }
  ).catch(
    (err) => console.error("error dropping database", err.message)
  )
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
					resultSet.push(this._fromFirebase(request.params.type, snapShot))
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

FirebaseStore.prototype._toFirebase= function(rawData) {
  const document = _.omitBy(rawData, (value) => value === undefined );
  this.relationshipAttributeNames.forEach(
    attributeName => {
      const value     = rawData[attributeName]
      const attribute = this.resourceConfig.attributes[attributeName]
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

FirebaseStore.prototype._fromFirebase= function(type, snapShot) {
	// convert all relationship
	const rawData = snapShot.val()
	rawData.id = snapShot.ref.key
	rawData.type = type
  this.relationshipAttributeNames.forEach(
    attributeName => {
      const value     = rawData[attributeName]
      const attribute = this.resourceConfig.attributes[attributeName]
      if (value) {
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
    }
  )
  return rawData
}

/**
  Find a specific resource, given a resource type and and id.
 */
FirebaseStore.prototype.find = function(request, callback) {
  const ref = this.firebaseApp.database().ref(`${request.params.type}/${request.params.id}`)

  debug("findOne", JSON.stringify({ id: request.params.id }));
  return ref.once("value").then(
    dataSnapShot => {
      if (dataSnapShot.exists()) {
        return callback(null,
          this._fromFirebase(request.params.type, dataSnapShot)
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
  const document = this._toFirebase(newResource)
	newResource.id = newRef.key
  debug("insert", JSON.stringify(document));
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
  const partialDocument = this._toFirebase(partialResource)
  debug("findOneAndUpdate", JSON.stringify(partialDocument));
  ref.update(partialDocument).then(
    () => callback(null, partialResource)
  ).catch(
    e => callback(
      FirebaseStore._unknownError(e)
    )
  )
};

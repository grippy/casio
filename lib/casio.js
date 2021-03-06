var _ = require('underscore');
var async = require('async');
var Buffer = require('buffer').Buffer;
var Cassandra = require('cassandra-client');
var crypto = require('crypto');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var association = require('./association');
var ConnectionPool  = require('./connection-pool');
var CQL = exports.CQL = require('./cql').CQL // export the CQL module

/*

API DOCS => http://wiki.apache.org/cassandra/API

todo:

Column Family Validation Types:
    x - Text
    x - Counter (support counter column types)

- Model._options
    - partition consitency for read vs. writes

- Model.property
    x - String
    x - Date
    x - Number
    x - Boolean
    x - BigInts
        x - convert bigint using parseInt(num, 0)
            (this essentially makes it a Int32)

    x - Object (has one & belongs to)
    x - List  (has many)

x - Model.find
    x - override returned class
    x - need to account for deleted tombstone markers
        x - filter from results

x - Model.delete

x - Model.get
    x - cql select statement gen
    x - override returned class
    x - need to account for deleted tombstone markers
        x - returns null if detected

x - Model.prototype.create
    x - cql insert statement gen
    x - make sure the primary key is always the first column in the cql statement

x - Model.prototype.update
    x - cql update statement gen

x - Model.prototype.delete
    x - cql delete statement gen
    x - mark the object as 'deleted'

x - Pooled Connections
x - Model Validations
x - Property Validations
x - Batch CQL queries

x - Model TTL support
- Model Timestamp
- Model Event Hooks


- Eager loading
  x - Model.prototype.get
  - Model.find

==================

- ModelArray.range
- ModelArray.find
- ModelArray.delete
x - ModeArray.cql
x - ModelArray.prototype.cql
x - ModelArray.prototype.hasNext
x - ModelArray.prototype.hasPrev
x - ModelArray.prototype.rows
x - ModelArray.prototype.row
x - ModelArray.prototype.rowCount
x - ModelArray.prototype.created
x - ModelArray.prototype.deleted
x - ModelArray.prototype.next
x - ModelArray.prototype.prev
x - ModelArray.prototype.set
x - ModelArray.prototype.create
x - ModelArray.prototype.update
x - ModelArray.prototype.delete


*/

/*
-- CQL Type     Description
-- ascii        US-ASCII character string
-- bigint       64-bit signed long
-- blob         Arbitrary hexadecimal bytes (no validation)
-- boolean      true or false
-- counter      Distributed counter value (64-bit long)
-- decimal      Variable-precision decimal
-- double       64-bit IEEE-754 floating point
-- float        32-bit IEEE-754 floating point
-- int          32-bit signed integer
-- text         UTF-8 encoded string
-- timestamp    Date plus time, encoded as 8 bytes since epoch
-- uuid         Type 1 or type 4 UUID
-- varchar      UTF-8 encoded string
-- varint       Arbitrary-precision integer


ZERO
ONE
QUORUM
ALL
DCQUORUM
DCQUORUMSYNC

Write
ANY
ONE
TWO
THREE
QUORUM
LOCAL_QUORUM
EACH_QUORUM
ALL

Read
ANY
ONE
TWO
THREE
QUORUM
LOCAL_QUORUM
EACH_QUORUM
ALL

*/


var nullCallback = function () {};


//
var Casio = module.exports.Casio = function (options) {
    this._models = {};
    this._options = options;
    this.connection = null;

    var self = this;
    if (options.useCasioPool) {
        this.connection = new ConnectionPool(options);
    }
    else {
        this.connection = new Cassandra.PooledConnection(options);
        this.connection.connect(nullCallback);
    }

    // Forward some events from the Connection to the parent
    ['error', 'log', 'timing'].forEach(function (eventName) {
      self.connection.on(eventName, function() {
          self.emit.apply(self, [eventName].concat(Array.prototype.slice.call(arguments)));
      });
    });

    EventEmitter.call(this);
};
util.inherits(Casio, EventEmitter);

Casio.types = {BigInteger: Cassandra.BigInteger};

Casio.prototype.register = function(model){
    this._models[model.prototype.__cfname] = model;
};

// Default consistency levels. Can be changed by a client for global effect.
//  see => http://wiki.apache.org/cassandra/API
Casio.prototype.consistency = {
    select: 'ONE',
    insert: 'ONE',
    update: 'ONE',
    delete: 'ONE'
};


var AbstractModel = function () {};

/**
    AbstractModel.classMethods

        Extend class methods

    @methods    - object of methods
**/
AbstractModel.classMethods = function(methods){
    // _.extend(this, methods)
    for (var name in methods){
        if (this[name] !== undefined){
            throw new Error('Falied to extend classMethod. ' +
                this.prototype.__cfname + '#' + name + '() already exists.');
        }
        this[name] = methods[name];
    }
};

/**
    AbstractModel.instanceMethods

        Extend methods as instance methods

    @methods    - object of methods
**/
AbstractModel.instanceMethods = function(methods){
    for (var name in methods){
        if (this.prototype[name] !== undefined){
            throw new Error('Falied to extend instanceMethod. ' +
                this.prototype.__cfname + '#' + name + '() already exists.');
        }
        this.prototype[name] = methods[name];
    }
};

/**
    AbstractModel.getter

    @name - the name of the method we want to define as a getter
    @fn   - the method to define as a getter

      Example:
      function(){
        return this._some_property;
      }

**/
AbstractModel.getter = function(name, fn) {
    if (!this.prototype._schema[name] && this.prototype[name] !== undefined){
        throw new Error('Falied to attach getter. ' +
            this.prototype.__cfname + '#' + name + ' already exists.');
    }
    this.prototype.__defineGetter__(name, fn);
    this.prototype._getters[name] = fn;

};

/**
    AbstractModel.setter

    @name - the name of the method we want to define as a setter
    @fn   - the method to define as a setter

      Example:
      function(v){
        this._some_property = v;
      }

**/
AbstractModel.setter = function(name, fn) {
    if (!this.prototype._schema[name] && this.prototype[name] !== undefined){
        throw new Error('Falied to attach setter. ' +
            this.prototype.__cfname + '#' + name + ' already exists.');
    }
    this.prototype.__defineSetter__(name, fn);
    this.prototype._setters[name] = fn;
};


/**
    AbstractModel.incr

        Increment a key.column counter this many times

    @key    - the key we want to work on
    @col    - the column counter
    @i      - the incr value (+/- ok); defaults to +1
    @callback
**/
AbstractModel.incr = function(key, col, i, callback) {
    // Allow for optional increment count
    if (typeof(i) === 'function') {
        callback = i;
        i = 1;
    }

    i = i || 1;
    callback = callback || nullCallback;

    var counter = {}; counter[col] = i;
    var q = new CQL('incr counter')
        .update(this.prototype.__cfname)
        .consistency(this.prototype._options.consistency.update)
        .counter(counter)
        .where(this.keyAlias + '=:key', {key: key});

    this.cql(q.statement(), [], callback);
};

/**
    AbstractModel.decr

        Decrement a key.column counter (i) number of times
        This is just a wrapper for Model.incr and negates the i value

    @key    - the key we want to work on
    @col    - the column counter
    @i      - the incr value (+ num only); defaults to -1
    @callback

**/
AbstractModel.decr = function(key, col, i, callback) {
    // Allow for optional increment count
    if (typeof(i) === 'function'){
        callback = i;
        i = 1;
    }

    this.incr(key, col, -(i || 1), callback);
};

/**
    AbstractModel.outputTiming

        Method to shed some light on where query latency is coming from.

    @qry        - cql string with optional replacement tokens (?)
    @args       - metadata from the query executiong

**/
AbstractModel.outputTiming = AbstractModel.prototype.outputTiming = function (query, results, metadata) {
    if (!metadata) return;

    var connection = this.connection || this.prototype.connection;
    connection.emit('timing', query, metadata.connectionInfo.host, 
        metadata.timingInfo.queryLatency, metadata.timingInfo.poolLatency, results);
};

/**
    AbstractModel.cql

        Execute a CQL query

    @qry        - cql string with optional replacement tokens (?)
    @args       - list of query arg tokens to replace
    @callback

**/
AbstractModel.cql = AbstractModel.prototype.cql = function(qry, args, callback) {
    if (typeof args === 'function'){
        callback = args;
        args = [];
    }
    var connection = this.connection || this.prototype.connection;
    connection.execute(qry, args, _.bind(function (err, results, metadata) {
      this.outputTiming(qry, results, metadata);
      if (err) connection.emit('error', err);
      (callback || nullCallback)(err, results);
    }, this));
};

/**
    AbstractModel.prototype.ttl

      Sets a TTL in seconds
      TTL is passed to the CQL statement
      All columns being created/updated will get the TTL
      All create/updates will null this value
      to avoid them being reused, again on future updates

**/
AbstractModel.prototype.ttl = function(num){
  this._ttl = num;
};

/**
 * Add a where clause to the query, cql.
 * Handle two where cases that cql.where can't since it doesn't know this.keyAlias.
 *      [ids]           ->  keyAlias IN (ids)
 *      id              ->  keyAlias = id
 * Defer all other cases to cql.where
 */
AbstractModel.where = function (cql, keyAlias, primaryKey, where) {
    if (!where) return;
    if (!_.isArray(where) || where.length < 1) throw new Error('Invalid where');

    var clause = where[0];
    var args = where[1];
    var clauseMap = {}; clauseMap[keyAlias] = clause;

    // If where is an array and args isn't set, this must be an array of
    // primary keys
    if (_.isArray(where) && (!args || !_.isObject(args))) {
        return cql.where(clauseMap, args);
    }

    // Test to make sure that where isn't a fully-baked where clause.
    // It's a where clause if it already contains an operator like <, >, =, IN
    // If it doesn't, then it must be a single primary key.
    else if (_.isString(clause) && !args && !clause.match(/<|>|=|in ?\(/i)) {
        return cql.where(clauseMap, args);
    }

    // Let cql.where figure it out.
    else {
        // It's possible that the caller used the primary key in the clause
        // instead of the keyAlias. Do the replacement here for them.
        if (_.isString(clause) && keyAlias !== primaryKey) {
            // this doesn't account for the start
            // var re = new RegExp(primaryKey + '\b', 'g');

            // need to handle the edgecase:
            // 'someId in :someIds', {someIds:[...]}
            //  where someId would be replaced by 'KEY'
            //  we would end up with: 'someId in :KEYs'

            // so only replace someId and not its token...
            var re = new RegExp(primaryKey + '(?!\\w)', 'g');

            clause = clause.replace(re, keyAlias);
            args[keyAlias] = args[primaryKey];
        }

        return cql.where(clause, args);
    }
};

/**
    Model.prototype.toJSON
        Convert the model into a json representation

        Only serialize what's loaded...
        i.e. - not everthing the schema or associations say
                it should have...

        Also: disregard any property or association which
              has a toJSON:false setting.

    Todo: Looks messy. refactor this!!!
**/
AbstractModel.prototype.toJSON = function(attributes){
    // console.log('Casio.toJSON', this.__cfname)
    if (this.__type__ === 'ModelArray') {
      if (this.toJSON) return this.toJSON();
      return this;
    }

    // make sure we have these properties...;
    if (!_.isArray(attributes)){
      attributes = [] ;
      if (this._schema){
        attributes = attributes.concat(_.keys(this._schema));
      }
      if (this._getters){
        attributes = attributes.concat(_.keys(this._getters));
      }
      if (this._belongsTo){
        attributes = attributes.concat(_.keys(this._belongsTo));
      }
      if (this._hasOne){
        attributes = attributes.concat(_.keys(this._hasOne));
      }
      if (this._hasMany){
        attributes = attributes.concat(_.keys(this._hasMany));
      }
      if (this._externals) {
        attributes = attributes.concat(this._externals);
      }
    }

    var self = this;
    var obj = {}, val, opts;
    _.each(attributes, function(attr) {
        if (self._schema && self._schema[attr]) {
          opts = self._schema[attr];

          // check to make sure we can serialize this attr
          if (opts.toJSON !== undefined && !opts.toJSON){
            return;
          }
          switch (opts.type) {
              case Boolean:
                obj[attr] = self[attr];
                break;
              case Number:
                val = self[attr];
                // the client may try and convert this to a big int
                // unfortunately we need to toString() or we lose anything
                // over 32-bits;
                if (val instanceof Casio.types.BigInteger){
                  val = val.toString();
                }
                obj[attr] = val;
                break;
              case String:
                obj[attr] = self[attr];
                break;
              case Date:
                obj[attr] = self[attr];
                break
              case Casio.types.BigInteger:
                obj[attr] = self[attr].toString();
                break
              case Object:
                if (self[attr] && self[attr].toJSON) {
                  obj[attr] = self[attr].toJSON();
                }
              default:
                break
          }
        } else if (self._getters[attr]){
          val = self[attr];
          if (val===undefined) return;
          if (val && val.toJSON) {
            obj[attr] = val.toJSON();
          } else {
            obj[attr] = val;
          }
        } else if (self._belongsTo && self._belongsTo[attr]) {

          // grab the belongsTo options
          opts = self._belongsTo[attr];
          // check to make sure we can serialize this attr
          if (opts.toJSON !== undefined && !opts.toJSON){
            return;
          }
          if (self[attr] && self[attr].toJSON) {
            obj[attr] = self[attr].toJSON();
          }

        } else if (self._hasOne && self._hasOne[attr]) {
          // grab the hasOne options
          opts = self._hasOne[attr];
          // check to make sure we can serialize this attr
          if (opts.toJSON !== undefined && !opts.toJSON){
            return;
          }
          if (self[attr] && self[attr].toJSON) {
            obj[attr] = self[attr].toJSON();
          }

        } else if (self._hasMany && self._hasMany[attr]){
          // needs to loop over all of the manies...
          // need to also check if we should even serialize
          // the member at all...

          // grab the hasMany options
          opts = self._hasMany[attr];
          if (opts.toJSON !== undefined && !opts.toJSON){
            return;
          }

          var manies = [];
          _.each(self[attr], function(one){
            if (one.toJSON) {
              manies.push(one.toJSON());
            }
          })
          obj[attr] = manies;
        } else if (_.contains(self._externals, attr)) {
          // the _externals array is a helper array that allows casio library
          // users to add non model fields to the object that will be serialized
          // with the rest of the model fields
          val = self[attr];
          if (val===undefined) return;
          if (val && val.toJSON) {
            obj[attr] = val.toJSON();
          } else {
            obj[attr] = val;
          }
        }
    });
    return obj;
};

AbstractModel.prototype.toString = function(attributes){
    return JSON.stringify(this.toJSON(attributes));
};

Casio.prototype.model = function(name, opts) {

    // set up our default Model options
    opts = opts || {};
    _.defaults(opts, {
        //  see => http://wiki.apache.org/cassandra/API
        consistency: this.consistency,
        get: {
            columns: ['*']
        },
        delete: {
            columns: ['*']
        },
        keyAlias: 'KEY'
    });

    // console.log('MODEL', name, opts)
    /**
        Model

            Constructor for the Model class

        @attrs   - the properties object to initialize
    **/
    var Model = function Model (attrs) {
        // console.log('Model#init', attrs)

        // cache the attrs so we can check
        // for dirty values on upate...
        this._props = {};

        // should we eager load a relationship?
        this._eager = {};

        // placeholder for errors...
        this._errors = {};

        // which values need to be written.
        this._dirty = {};

        // array of extra properties
        // we want to serialize as JSON
        this._externals = [];

        this._cftimestamp = {};

        this.initialize(attrs);

        // default all hasMany properties...
        for (var p in this._hasMany){
            this[p] = [];
        }

        return this;
    };

    _.extend(Model, AbstractModel);
    _.extend(Model.prototype, AbstractModel.prototype);

    // Attach the Casio instance connection to all associated models.
    Model.prototype.connection = this.connection;

    /**
        Model.prototype.initialize

            Set all the model's properties with a default or a passed in value.
    **/
    Model.prototype.initialize = function (attrs) {

      // Set defaults and copy attrs;
      var colDef;
      for (var name in this._schema) {
          colDef = this._schema[name];
          this[name] = colDef.default;
          this._props[name] = colDef.default;

          // now update the instance with this property value
          if (!_.isObject(attrs) || attrs[name] === undefined) continue;

          var value = attrs[name];
          switch(colDef.type) {
              case Boolean:
                  // coming from cassandra client these will be string buffers
                  if (Buffer.isBuffer(value)) {
                      value = (value[0] !== 0);
                  }
                  // just-in-case someone sets a boolean with a 0 or 1
                  else if (_.isNumber(value)) {
                      if (value < 0 && value > 1) {
                          throw new Error('Tried setting a boolean with an integer value other then 1 or 0');
                      }
                      value = (value[0] !== 0);
                  }
                  // there's a use-case if we write to a column not defined at all
                  // and the default validator is utf8
                  // it will come back as string
                  else if (_.isString(value)){
                    if (value === 'true' || value === '1') {
                      value = true;
                    } else if (value === 'false' || value === '0') {
                      value = false;
                    } else {
                      throw new Error('Tried setting a boolean using a string other then \'true\' or \'false\'');
                    }
                  }
                  break;
              case Casio.types.BigInteger:
                  // todo: figure what to with BigInteger values here...
                  value = parseInt(value.toString(), 10);
                  break
              default:
                  break;
          }
          this[name] = value;
      }
      if (!_.isObject(attrs)) {
          this[Model.primary()] = attrs;
      } else {
        // Also include any unexpected props and update the cf timestamp data.
        // These non-schema properties will not be included in the return from
        // toJSON. Nor will they automatically be marked for update on a save
        // unless they are set with Model.prototype.set.
        this._cftimestamp = attrs._cftimestamp;
        _.defaults(this, attrs);
      }

    };

    /**
        Model.primary

            Return the primary key column;
            caches a copy of the primary key name or null after first lookup
            returns: undefined or column name
    **/
    Model.primary = function () {
        if (this.prototype._primary !== undefined) {
            return this.prototype._primary;
        }

        // Find a primary key if one exists and cache it.
        for (var property in this.prototype._schema) {
            if (this.prototype._schema[property].primary) {
                this.prototype._primary = property;
                break;
            }
        }

        return this.prototype._primary;
    };

    // Make a public property for the key alias name
    Model.keyAlias = opts.keyAlias;

    /**
        Model.property

            define a prop with name as type with these options

        @p      - The name of the property to define
        @type   - String, Number, Date, etc.
        @opts   - options for this property type
    **/
    Model.property = function(p, type, opts){

      // don't allow defining a property with a name already on the class.
      if (this.prototype[p] !== undefined) {
        throw new Error(this.prototype.__cfname + '.' + p +
            ' already exists on this class. Please choose a differnt name.')
      }

      opts = opts || {};
      opts.type = type;

      if (opts.default === undefined) {
          switch(opts.type) {
              case String:
              case Number:
              case Object:
              default:
                  _default = null;
                  break
          }
          opts.default = _default;
      }

      // its tempting to set notNull if we have a primary
      // but this should be explicit
      // because validation fires before the uuid kicks in.

      // set up validators
      if (opts.validators === undefined) {
        opts.validators = [];
      }
      else {
        if (typeof(opts.validators) === 'function') {
          opts.validators = [opts.validators];
        }
      }

      if (opts.notNull) {
        opts.validators.push(function (prop, val) {
          if (val===null) this.error(prop, ':prop is null.');
        })
      }
      // save our schema options
      this.prototype._schema[p] = opts;

      // make all properties getter setters....
      this.prototype.__defineGetter__(p, function(){
        return this['_' + p];
      });
      this.prototype.__defineSetter__(p, function(val){
        this['_' + p] = val;
      });

    };

    /**
        Model.belongsTo

            Define a belongsTo association as:
                A model.property is a primary key on another columnfamily

        @p      - the name of the has one property
        @type   - the class to instantiate as
        @opts   - the association options.
            {
                on:'association primary key column',
                fk:'the foreign key on the model'
            }

        Example:
        //todo: allow setting via: User.property('personId', Number, {has: 'person', as: Person});

        User.belongsTo('person', Person, {});

        By default, we set both 'on' and 'fk' to the defined Person.primary column name.
        So, there is no need to set these if they're are the same.

        User.belongsTo('person', Person, {
            on:'personId', // the Person column to associate
            fk:'personId'  // the User column to associate
        });

        You'll also want to define an additional Model.property for the 'personId'
        Otherwise, it won't be saved properly.

        User.property('personId', Number, {})

    **/
    Model.belongsTo = function(p, type, opts){
        opts = opts || {};
        opts.type = type;

        // must have opts.fk && opts.on defined
        // otherwise won't be able to eager load, etc.
        // default to the primary col name
        if (opts.on === undefined) {
            opts.on = type.primary();
        }
        // default to the primary col name
        if (opts.fk === undefined) {
            opts.fk = type.primary();
        }

        if (opts.default === undefined) {
            opts.default = null;
        }
        this.prototype._belongsTo[p] = opts;
    };

    /**
        Model.hasMany

            Define a hasMany association as:

                A list of objects where model.primary is a
                primary or secondary index on another columnfamily

        @p      - the name to define this list as
        @type   - the class to instantiate the list objects as
        @opts   - the options to configure for this association
            {
                on:'the primary or secondary index column'
            }

        Requires setting an 'on' value if its different then the model.primary.
        In addition, this column will also need an index.
        Since the CQL query looks something like:

            "select * from <columnfamily> where <key>=:key"

    **/
    Model.hasMany = function(p, type, opts){
        opts = opts || {};
        opts.type = type;


        // make sure we don't allow defining hasMany ModelArray;
        if (type.prototype.__type__ && type.prototype.__type__==='ModelArray'){
            throw new Error(this.prototype.__cfname + '.' + p + ' error:' +
                ' hasMany definitions using ModelArray aren\'t supported.' +
                ' Try hasOne or belongsTo instead.')
        }

        // must have opts.fk && opts.on defined
        // otherwise won't be able to eager load, etc.
        // default to the primary col name
        if (opts.on === undefined){
            opts.on = Model.primary();
        }

        // default to the primary col name
        // if (opts.fk === undefined){
        //     opts.fk = type.primary()
        // }

        // defaults to empty list
        opts.default = [];
        this.prototype._hasMany[p] = opts;
    };

    /**
        Model.hasOne

            Define a hasOne association as
            model.primary is a primary or seconday index on another columnfamily

    **/
    Model.hasOne = function(p, type, opts){
        opts = opts || {};
        opts.type = type;

        if (opts.on === undefined){
            opts.on=Model.primary();
        }
        if (opts.default===undefined) {
            opts.default = null;
        }
        this.prototype._hasOne[p] = opts;
    };


    /**
        Model.prepareCqlArgs

            Massage a list of args for a CQL.where clause

        @args
    **/
    Model.prepareCqlArgs = function(args){
        var primary = this.primary();
        if (typeof(args) !== 'object'){
            // we should have a string here...
            args = {
                where: [Model.keyAlias + '=:key', {key:args}]
            }
        } else {
            // do we have a where clause?
            if (args.where === undefined){
                args.where = [Model.keyAlias + '=:key', {key: args[primary]}];
            }
        }

        // we need to account for the keyAlias and primary situation...
        if (Model.keyAlias !== primary){
            var re = new RegExp(primary + '(?!\\w)', 'g');
            args.where[0] = args.where[0].replace(re, Model.keyAlias);
        }

        if (args.columns !== undefined){
            if (typeof(args.columns) === 'string'){
                args.columns = [args.columns];
            }
        }

        return args
    };



    /**
        Model.find

            Take the args query plan and
            return them in the callback

        @args   - the cql args object
                {
                    // the columns to select for each row
                    columns:'*' || ['c1', 'c2', 'c3'],

                    // where clause to perform
                    where: ['key=:key', {key:'somthing'}]
                    -or-
                    where: ['key IN (:keys)', {keys:[1, 2, 3, 4, ...]}]
                    -or-
                    where: 'clause as a string'

                    // optional shallow class to instanitate rows as
                    as: ClassName

                }
        @callback

    **/
    Model.find = function (args, callback) {
        if (args.columns !== undefined){
            if (typeof(args.columns) === 'string'){
                args.columns = [args.columns];
            }
        } else {
            args.columns = ['*'];
        }

        var q = new CQL('find');
        q.select(args.columns);
        q.from(Model.prototype.__cfname);

        AbstractModel.where(q, Model.keyAlias, Model.primary(), args.where);

        if (args.first !== undefined) {
            q.first(args.first);
        }
        if (args.limit !== undefined) {
            q.limit(args.limit);
        }

        q.consistency(Model.prototype._options.consistency.select);
        var statement = q.statement();
        Model.cql(statement, [], function(err, results){

            if (err) return callback(err, null);
            var models=[], eagerOrder = [];

            // loop over all the results
            for (var i=0, ii=results.length, row; i<ii; i++){

                row = results[i];
                var props = row.colHash;
                props.key = row.key;
                props[Model.primary()] = row.key;
                props._cftimestamp = {};
                _.each(row.cols, function(col) {
                  props._cftimestamp[col.name] = col.timestamp;
                });
                // Designate that casio loaded this model from the DB.
                props['_loaded'] = true;

                var absent = row._colCount === 0 || args.columns &&
                             (args.columns.length > 1 || args.columns[0] === '*') &&
                             row._colCount == 1 &&
                             row.cols[0].name === Model.primary();

                if (absent) continue;


                var model;

                if (args.as === undefined){
                    model = new Model(props);
                    model.shadow();
                    // do we have an eager association to load?

                    if (args.eager !== undefined){
                        // copy the eager args onto our model...
                        model._eager = args.eager;

                        for (var p in args.eager){
                            if (Model.prototype._hasOne[p] !== undefined) {
                                eagerOrder.push(
                                    association.hasOne(
                                        Model.prototype._hasOne[p],
                                        model,
                                        p,
                                        args)
                                 );
                             } else if (Model.prototype._hasMany[p] !== undefined) {
                               eagerOrder.push(
                                   association.hasMany(
                                       Model.prototype._hasMany[p],
                                       model,
                                       p,
                                       args)
                                );
                            } else if (Model.prototype._belongsTo[p] !== undefined) {

                                eagerOrder.push(
                                    association.belongsTo(
                                        Model.prototype._belongsTo[p],
                                        model,
                                        p,
                                        args)
                                );
                            }
                        }
                    }

                } else {
                    model = new args.as(props);
                }

                models.push(model);
            }

            async.series(eagerOrder, function(err, results) {
                callback(null, models);
            });

        });
    };

    /**
        Model.get

            Return a single instance of a model.
            By default, the model is
                instantiated as this model
            Setting the '@args.as' value will overrride
                how results are transformed

        @args = key

            -or-

        @args = {} see Model.find for this pattern.
        @callback - [err, results]
    **/
    Model.get = function(args, callback) {
        // grab the options
        var opts = Model.prototype._options;

        // massage the args for a get statement
        args = Model.prepareCqlArgs(args);

        // we didn't have columns here then look up the default options...
        if (args.columns===undefined){
            if (opts.get.columns){
                args.columns = opts.get.columns;
            } else if (opts.get.start || opts.get.end) {
                args.start = opts.get.start || '';
                args.end = opts.get.end || '';
            }
        }

        var q = new CQL('get');
        if (args.columns !== undefined){
            q.select(args.columns);
        } else if(args.start || args.end) {
            q.select();
            q.range(args.start, args.end);
        } else {
            throw new Error('Missing columns or a range for Model.get')
        }

        q.from(Model.prototype.__cfname);
        q.consistency(opts.consistency.select)

        AbstractModel.where(q, Model.keyAlias, Model.primary(), args.where);

        Model.cql(q.statement(), [], function (err, results) {

            if (err) return callback(err, null);
            if (!results.length) return callback(null, null);

            // we need to check if this item was marked for delete
            // the only way to determine is we'll only have on column
            // with a primary key because of the tombstone
            // { key: 'f23aeef7-8b95-4001-88a2-658a3df330e4',
            //   cols:
            //    [ { name: 'userId',
            //        value: 'f23aeef7-8b95-4001-88a2-658a3df330e4' } ],
            //   colHash: { userId: 'f23aeef7-8b95-4001-88a2-658a3df330e4' },
            //   _colCount: 1 }

            // checking for tombstones is rough...
            // depends on if the we selected columns or a range

            var first = results[0];
            var absent = first._colCount === 0 || args.columns &&
                         (args.columns.length > 1 || args.columns[0] === '*') &&
                         first._colCount == 1 &&
                         first.cols[0].name === Model.primary();

            // instantiate models?
            if (absent) return callback(null, null);

            var props = first.colHash;
            props.key = first.key;

            // we need to set the primary key column
            // since it might be missing if we performed a range query.
            props[Model.primary()] = first.key;
            props._cftimestamp = {};
            _.each(first.cols, function(col) {
              props._cftimestamp[col.name] = col.timestamp;
            });
            // Designate that casio loaded this model from the DB.
            props['_loaded'] = true;

            if (args.as !== undefined) {
                // we're being told to not instantiate
                // these props as new Model();
                // instead as...
                return callback(null, new args.as(props));
            }

            // We made it this far, let's party with some models.
            var model = new Model(props);

            // Shadow the model properties
            // so we only update dirty props
            model.shadow();

            // do we have an eager association to load?
            var eagerOrder = [];
            if (args.eager !== undefined){
                // copy the eager args onto our model...
                model._eager = args.eager;

                for (var p in args.eager){
                    if (Model.prototype._hasOne[p] !== undefined) {
                        eagerOrder.push(
                            association.hasOne(
                                Model.prototype._hasOne[p],
                                model,
                                p,
                                args)
                         );
                     } else if (Model.prototype._hasMany[p] !== undefined) {
                       eagerOrder.push(
                           association.hasMany(
                               Model.prototype._hasMany[p],
                               model,
                               p,
                               args)
                        );
                    } else if (Model.prototype._belongsTo[p] !== undefined) {

                        eagerOrder.push(
                            association.belongsTo(
                                Model.prototype._belongsTo[p],
                                model,
                                p,
                                args)
                        );
                    }
                }
            }
            async.series(eagerOrder, function(err, results){
                callback(null, model);
            })

        });
    };

    /**
        Model.delete

            Delete the columns and primary keys passed by the args object

        @args       - see Model.find for this format
        @callback
    **/
    Model.delete = function(args, callback){

        var opts = this.prototype._options;

        // massage the args for a get statement
        args = this.prepareCqlArgs(args);

        // we didn't have columns here then look up the default options...
        if (args.columns === undefined) {
            args.columns = opts.delete.columns;
        }

        // '*' columns aren't needed for delete statements
        if (args.columns.toString() === '*'){
            args.columns = [];
        }

        var q = new CQL('Model.delete');
        q.delete(args.columns);
        q.from(this.prototype.__cfname);

        AbstractModel.where(q, Model.keyAlias, Model.primary(), args.where);

        // set consitency...
        q.consistency(opts.consistency.delete);

        // todo: set ttl...

        // set timestamp...
        q.timestamp(new Date().getTime());

        var statement = q.statement();
        // console.log(statement);

        this.cql(statement, [], function(err, results) {
            if (err) return callback(err);
            callback(null, results);
        });

    };


    /**
        Model.count

            Return a count where the where clause passes some condition

        @where      - list in the form of ['key=:key', {key:value}] (optional)
        @callback
    **/
    Model.count = function(where, callback){
        // do we have a where clause?
        if (typeof(where)==='function'){
            callback=where;
            where=[];
        }
        callback = callback || nullCallback;

        var q = new CQL('count').select(['count(*)']) // columns
                                .from(this.prototype.__cfname)
                                .where(where); // should skip empty values
        this.cql(q.statement(), [], function (err, results) {
            if (err) return callback(err);
            callback(err, results[0].colHash);
        });
    }

    _.extend(Model.prototype, {
        __type__: 'Model',

        // define instance variables here...
        // and then remember to set them in the constructor
        __cfname: null,
        _errors: null,
        _externals: null,
        _deleted: null,
        _created: null,
        _eager: null,
        _ttl: null,

        // define class variables;
        // these are shared between all instances
        _schema: {},
        _hasOne: {},
        _hasMany: {},
        _belongsTo: {},
        _getters: [],
        _setters: [],
        _options: {}
    });
    Model.prototype.__cfname = name;
    Model.prototype._options = opts;

    /**
        Model.prototype.error
          Set propperty error or Get all property errors or entire error graph
        @p    - if only p then we return all the errors for this property
        @msg  - if passing p and msg we push the message onto the property

    **/
    Model.prototype.error = function(p, msg){
      if (p === undefined) return this._errors
      if (msg !== undefined){

        if (this._errors[p] === undefined){
          this._errors[p] = [];
        }
        this._errors[p].push(msg.replace(/:prop/g, p));
        return
      } else {
        return this._errors[p];
      }
    };

    /**
        Model.prototype.validate
          Loop over all properties and run their validators
          A property validator should push an error
          onto _errors by property as key

    **/
    Model.prototype.validate = function(){
      // reset the errors since we're validating
      this._errors = {};

      var self = this;
      var colDef;
      for (var p in this._schema){
        colDef = this._schema[p];
        // console.log('VALIDATORS', colDef.validators)
        if (colDef.validators !== undefined){
          _.each(colDef.validators, function(fn){
            // we need to bind this to the the object
              fn.call(self, p, self[p]);
          })
        }
      }

      return (_.keys(this._errors).length) ? false : true;
    };

    /**
        Model.prototype.timestamp

            timestamp the column;
        @col    - the col to timestamp (mostly used for updatedat and createdat columns)
    **/
    Model.prototype.timestamp = function(col){
        for (var p in this._schema){
            if (p.replace(/[^a-zA-Z0-9]/g,'').toLowerCase() === col){
                this[p] = new Date();
                return p;
            }
        }
        return null;
    };

    /**
        Model.prototype.deleted

            Check to see if this model was deleted

    **/
    Model.prototype.deleted = function(){
        return this._deleted;
    };

    /**
        Model.prototype.created

            Check to see if this model was created

    **/
    Model.prototype.created = function(){
        return this._created;
    };

    /**
        Model.prototype.shadow
            refresh all model._props with current values
    **/
    Model.prototype.shadow = function(){
        this._dirty = {};
        for (var p in this._schema){
            this._props[p] = this[p];
        }
    };

    /**
        Model.prototype.clean
            refresh model._dirty with the empty set
    **/
    Model.prototype.clean = function(){
      this._dirty = {};
    };

    /**
        Model.prototype.eager
            The relationship graph we should load

    **/
    Model.prototype.eager = function(graph){
        this._eager = graph
    };

    /**
        Model.prototype.addExternal
            Add a field name to the external array for serialization
    **/
    Model.prototype.addExternal = function(val){
        this._externals.push(val);
    };

    /**
        Model.prototype.set - batch set the passed args
            @args - object of properties to set
    **/
    Model.prototype.set = function(args){
        if (args === undefined) return;
        _.extend(this, args);
        _.extend(this._dirty, args);
    };

    /**
        Model.prototype.update - update all the passed args or dirty properties

    **/
    Model.prototype.update = function(args, callback){

        if (args !== undefined){
            var type = typeof(args);
            // are the args an object?
            if (type === 'object'){
                this.set(args);
            } else if (type === 'function') {
                callback=args;
            }
        }
        // test if callback exists
        callback = callback || nullCallback;

        // does this validate?
        if (!this.validate()) {
          return callback(this._errors);
        }

        // update the hasOne props...
        var colDef;
        for (var p in this._belongsTo) {
            colDef = this._belongsTo[p];
            // console.log(colDef)
            if (this[p] !== undefined){
                var belongsTo = this[p];
                // console.log(colDef.type.primary(), belongsTo)
                this[colDef.fk] = belongsTo[colDef.type.primary()];
            }
        }

        // determine all dirty schema properties...
        var dirty = this._dirty, val;
        for (var p in this._schema){
            if (this[p] !== this._props[p]){
                val = this[p];
                if (val && val.constructor === Date){
                    val = val.getTime();
                }
                dirty[p] = val;
            }
        }

        // console.log('DIRTY', dirty);

        // we should have at least one dirty value
        if (!_.keys(dirty).length) {
            return callback();
        }

        // now set updated at
        // we may not have an updated at column
        var updatedAtCol = this.timestamp('updatedat');
        if (updatedAtCol) {
            dirty[updatedAtCol] = this[updatedAtCol].getTime();
        }
        // console.log('DIRTY', dirty);

        // create query plan to save dirty properties
        // create cql query
        var q = new CQL('create');
        q.update(this.__cfname);

        // set set args...
        q.set(dirty);

        // set consitency...
        q.consistency(this._options.consistency.update);

        // set ttl
        if (this._ttl) {
          q.ttl(this._ttl);
          this._ttl = null;
        }

        // set timestamp...
        q.timestamp(new Date().getTime());

        // todo: figure out what to do for models without primary keys
        var primary = Model.primary();
        q.where(Model.keyAlias + '=:key', {key: this[primary]});

        var statement = q.statement();
        var self = this;
        this.cql(statement, [], function(err, results){
            if (err) return callback(err);

            // update self._props with saved values
            self.shadow();

            callback(null, self);
        });

    };

    /**
        Model.prototype.create - Create the model...

            todo: determine how to handle 'default' values

            @callback
    **/
    Model.prototype.create = function(callback){

        // does this validate?
        if (!this.validate()) {
          return callback(this._errors);
        }

        // does this model have a primary key defined column
        // and is it set to something?
        var primary = Model.primary();
        if (primary !== undefined && primary !== null){
            var primaryDefined = (this[primary]) ? true : false;
            // console.log("primary:", primary, 'defined:', primaryDefined)
            // we don't have a primary key so define one
            if (!primaryDefined) {
                var uuid = new Cassandra.UUID().toString();
                // console.log('generating uuid:', uuid )
                this[primary] = uuid
            }
        }

        // timestamp updatedat && createdat (remove all formatting)
        this.timestamp('createdat');
        this.timestamp('updatedat');

        var into = [],
            values = [],
            val,
            primaryVal,
            colDef;

        for(var p in this._schema){
            colDef = this._schema[p];
            val = this[p];
            if (colDef.type === Date){
                if (val && val.constructor === Date){
                    val = val.getTime();
                }
            }

            // dont save undef or null values
            if (val!==undefined && val!=null){
                if (colDef.primary === undefined){
                    into.push(p);
                    values.push(val);
                } else {
                    primaryVal = val;
                }

            }
        }

        if (primaryVal) {
            into.push(Model.keyAlias);
            values.push(primaryVal);
        }

        // create cql query
        var q = new CQL('create');
        q.insert(this.__cfname);

        // make it so primary is the first key...
        q.into(into.reverse());
        q.values(values.reverse());

        // set consitency...
        q.consistency(this._options.consistency.insert);

        // set ttl
        if (this._ttl) {
          q.ttl(this._ttl);
          this._ttl = null;
        }

        // set timestamp...
        q.timestamp(new Date().getTime());

        var statement = q.statement();

        var self = this;
        this.cql(statement, [], function(err, results){
            if (err) return callback(err);

            // update self._props with saved values
            self.shadow();
            self._created = true;

            callback(null, self);
        })
    };

    /**
        Model.prototype.save

            The only way we can accurately gauge if a model has been created:
              1. If it has a primary key
              2. If createdat is set...

            Essentially a fork for either calling
            Model.prototype.create or
            Model.prototype.update

    **/
    Model.prototype.save = function(callback){

        var primary = Model.primary();
        var createdat;
        for (var p in this._schema){
            if (p.replace(/[^a-zA-Z0-9]/g,'').toLowerCase() === 'createdat'){
                break;
            }
        }
        if (this[primary] !== undefined && (createdat || this['_loaded'])) {
            this.update(callback);
        } else {
            this.create(callback);
        }
    };

    /**
        Model.prototype.incr - wrapper for Model.incr

    **/
    Model.prototype.incr = function(col, i, callback){
        Model.incr(this[Model.primary()], col, i, callback);
    };

    /**
        Model.prototype.decr - wrapper for Model.incr

    **/
    Model.prototype.decr = function(col, i, callback){
        Model.decr(this[Model.primary()], col, i, callback);
    };


    /**
        Model.prototype.delete

            Delete the model by its primary key

        @callback(err, results)
    **/
    Model.prototype.delete = function(callback){
        var self = this;
        Model.delete(this[Model.primary()], function (err, results) {
            if (err) return callback(err);

            self._deleted = true;
            callback();
        });
    };

    this.register(Model);

    return Model;
}



/////////////////////////////////////
// Casio Model Array
/////////////////////////////////////
Casio.prototype.array = function(name, opts){

    // set up our default ModelArray options
    opts = opts || {};
    _.defaults(opts, {
        consistency: this.consistency,
        // Column Families can be defined with reverse comparators
        // http://thelastpickle.com/2011/10/03/Reverse-Comparators/
        // This setting causes Casio to handle the CF correctly for range
        // queries. The client can be agnostic when writing queries.
        reversed: false,
        keyAlias: 'KEY'
    });

    /**
        ModelArray

            Constructor for the Model class

        @key    - the key for this model

    **/
    var ModelArray = function ModelArray (key) {
        this._key = key || new Cassandra.UUID().toString();

        // so we have a primary key with an public property name
        this[ModelArray.primary()] = this._key;

        this.reset();

        return this;
    };

    _.extend(ModelArray, AbstractModel);
    _.extend(ModelArray.prototype, AbstractModel.prototype);

    // Attach the Casio instance connection to all associated models.
    ModelArray.prototype.connection = this.connection;

    ModelArray.primary = function(name) {
        if (name === undefined) return this.prototype._primary;
        this.prototype._primary = name;
    };

    ModelArray.keyAlias = opts.keyAlias;

    /**
        ModelArray.find

            Return a list of ModelArray's

    **/
    ModelArray.find = function(args, callback) {
        throw new Error('Casio Error: ModelArray.find isn\'t implemented.')
    };

    /**
        ModelArray.range

            Multi-key range queries

    **/
    ModelArray.range = function(args, callback) {
        throw new Error('Casio Error: ModelArray.range isn\'t implemented.')
    };

    /**
        ModelArray.delete

            Multi-key delete queries

        @args       -   see Model.find for this format
        @callback
    **/
    ModelArray.delete = function(args, callback){
        throw new Error('Stub')
    };

    _.extend(ModelArray.prototype, {
        __type__:'ModelArray',
        __cfname:null,
        _options:{},
        _getters:{},
        _setters:{},
        _primary:'key',
        _rows:null,
        _ttl:null,
        _reversed:false,
        _hasNext:null,
        _hasPrev:null,
        _created:null,
        _deleted:null
    });
    ModelArray.prototype.__cfname = name;
    ModelArray.prototype._options = opts;

    /**
         ModelArray.prototype.range

            @args {
                start: '0',
                end: '',
                first: 10,
                reversed: true,
                limit: 10 // does nothing for range queries (use first, instead)
            }

         todo: if the original range query was reversed
                we need to set
                prev -> next
                and
                next -> prev

    **/
    ModelArray.prototype.range = function(args, callback) {
        args = args || {};
        if (typeof args === 'function') { callback = args; args = {}; }
        if (args.constructor !== Object && args.constructor === Number) {
            args = {first: args};
        }

        // Save the state of the first query for use in next and prev
        this.reset();
        this._args = _.clone(args);
        this.query(this._args, callback);
    };

    /**
         ModelArray.prototype.next

            return more columns for this primary key

        @args   - num of rows to return going forward since the end last row
        -or-
        @args   - range query object structure (see ModelArray.prototype.range())

    **/
    ModelArray.prototype.next = function (args, callback) {
        args = args || {};
        if (!this._args || !this._rows.length) {
            return callback(new Error('Must call range() before calling next()'));
        }
        if (args.constructor !== Object && args.constructor === Number) {
            args = {first: args};
        }

        this.query({
            start: this._rows[this._rows.length-1].name + '\0',
            end: args.end || '',
            first: args.first || this.args.first,
        }, (callback || args));
    };

   /**
         ModelArray.prototype.prev

            return more columns for this primary key

        @args   - num of rows to return going backward from the first row
        -or-
        @args   - range query object structure (see ModelArray.prototype.range())

    **/
    ModelArray.prototype.prev = function (args, callback) {
        args = args || {};
        if (!this._args || !this._rows.length) {
            return callback(new Error('Must call range() before calling prev()'));
        }
        if (args.constructor !== Object && args.constructor === Number) {
            args = {first: args};
        }

        this.query({
            start: this._rows[0].name,
            end: args.end || '',
            first: args.first || this.args.first,
            reversed: true,
            previous: true
        }, (callback || args));
    };

   /**
         ModelArray.prototype.query

            return more columns for this primary key

        @args   - num of rows to return going backward from the first row
        -or-
        @args   - range query object structure (see ModelArray.prototype.range())

    **/
    ModelArray.prototype.query = function (args, callback) {
      var self = this;

      var update = function(err, cols) {
        if (err) return callback(err);

        var end = (args.first || cols.length);

        if (args.previous) {
            self._hasPrev = args.first ? (cols.length > args.first) : undefined;
            cols = cols.slice(1, end + 1).reverse();
            self._rows = cols.concat(self._rows);
        }
        else {
            self._hasNext = args.first ? (cols.length > args.first) : undefined;
            cols = cols.slice(0, end);
            self._rows = self._rows.concat(cols);
        }

        callback(null, cols);
      };

      args = args || {};
      if (typeof args === 'function') { callback = args; args = {}; }
      if (args.constructor !== Object && args.constructor === Number) {
          args = {first: args};
      }

      // To shard or not to shard, that is the question!
      if (Array.isArray(this._options.shards)) {
        this.multiQuery(args, update);
      }
      else {
        this.singleQuery(args, update);
      }
    };

    ModelArray.prototype.multiQuery = function (args, callback) {
      var self = this;

      async.map(this._options.shards, function (shard, callback) {
        var key = self._key + (shard ? ':' + shard : '');
        self.singleQuery(_.extend(args, {key: key}), callback);
      }, function (err, results) {
        if (err) return callback(err);
        callback(null, mergeRows(results, self._options.reversed));
      });
    };

    ModelArray.prototype.singleQuery = function (args, callback) {
        var start = (this._options.reversed ? args.end : args.start) || '';
        var end = (this._options.reversed ? args.start : args.end) || '';
        var q = new CQL('ModelArray.prototype#range').select()
            .range(start || '', end || '')
            .from(this.__cfname)
            .where(ModelArray.keyAlias + '=:key', {key: args.key || this._key})
            .reversed(args.reversed)
            .consistency(this._options.consistency.select);

        // fetch an extra row to check if another query would return data.
        if (args.first !== undefined) q.first(args.first + 1);

        this.cql(q.statement(), [], function (err, results) {
          if (err) return callback(err);
          callback(null, results && results[0] && results[0].cols || []);
        });
    };

    /**
         ModelArray.prototype.rowCount

            Return the current length of our _rows property
    **/
    ModelArray.prototype.rowCount = function() {
         return this._rows.length;
    };

    /**
         ModelArray.prototype.rows

            Return all the rows on this object
    **/
    ModelArray.prototype.rows = function() {
         return this._rows;
    };

    /**
         ModelArray.prototype.row(name)

            Lookup a single row and return it if it exits...

        @name   <string> the name of the row.name to return
        -or-
        @name   <number> the name of the row index to return

    **/
    ModelArray.prototype.row = function(name) {
        if (name===undefined) return null;
        if (name.constructor === String){
            for (var i = 0, ii = this._rows.length, row; i<ii;i++){
                row = this._rows[i];
                if (row.name === name){
                    return row;
                }
            }
        } else if (name.constructor===Number){
             if (this._rows.length >= name){
                 return this._rows[name];
             }
        }
        return null;
    };


    // Underscore methods that we want to implement on the ModelArray.
    var methods = ['forEach', 'each', 'map', 'reduce', 'reduceRight', 'find', 'detect',
    'filter', 'select', 'reject', 'every', 'all', 'some', 'any', 'include',
    'contains', 'invoke', 'max', 'min', 'sortBy', 'sortedIndex', 'toArray', 'size',
    'first', 'rest', 'last', 'without', 'indexOf', 'lastIndexOf', 'isEmpty', 'groupBy', 'pluck'];

    // Mix in each Underscore method as a proxy to `ModelArray#_rows`.
    _.each(methods, function(method) {
        ModelArray.prototype[method] = function() {
          return _[method].apply(_, [this._rows].concat(_.toArray(arguments)));
        };
    });

    /**
         ModelArray.prototype.hasNext

            After searching for a range and then a next query
            is there a next one?

    **/
    ModelArray.prototype.hasNext = function() {
         // Only return false if there's an explicit false
         return this._hasNext !== false;
    };

    /**
         ModelArray.prototype.hasPrev

            After searching for a range and then a previous query
            is there another previous query?

    **/
    ModelArray.prototype.hasPrev = function() {
         // Only return false if there's an explicit false
         return this._hasPrev !== false;
    };

    /**
         ModelArray.prototype.reset
            Except for the key, reset most object properties

    **/
    ModelArray.prototype.reset = function() {
        this._rows = [];
        this._args = null;
        this._hasNext = false;
        this._hasPrev = false;
    };

    /**
        ModelArray.prototype.set

            set rows to be inserted as columns for the primary key
            prevserves all existing instance rows
            removes duplicates matching on row.name
            sort by row.name

        @rows - A single row object {name:'', value:''}
        -or-
        @rows - An array of row objects {name:'', value:''}

    **/
    ModelArray.prototype.set = function(rows) {

        if (rows.constructor === Object){
            rows = [rows];
        }

        // this need to remove current rows matching the row.name
        var temp = [];
        for (var i = 0, ii = this._rows.length, row; i<ii;i++){
            row = this._rows[i];
            _.each(rows, function(r){
                if (row.name === r.name){
                    row.name = null;
                }
            })
        }
        _.map(this._rows, function(row){
            if (row.name){
                temp.push(row)
            }
        })

        // concat and sort these now
        temp = temp.concat(rows).sort(function(a, b){
            return a.name - b.name;
        });
        this._rows = temp;
    };

    /**
        ModelArray.prototype.deleted

            Check to see if this model was deleted

    **/
    ModelArray.prototype.deleted = function(){
        return this._deleted;
    };

    /**
        ModelArray.prototype.created

            Check to see if this model was created

    **/
    ModelArray.prototype.created = function(){
        return this._created;
    };

    /**
         ModelArray.prototype.create

    **/
    ModelArray.prototype.create = function(callback) {


        // create cql query
        var q = new CQL('ModelArray.prototype.create');
        q.insert(this.__cfname);

        var into = [ModelArray.keyAlias];
        var values = [this._key];
        _.each(this._rows, function(row){
            into.push(row.name);
            values.push(row.value);
        })

        // set set args...
        q.into(into);
        q.values(values);

        // set consitency...
        q.consistency(this._options.consistency.insert)

        // set ttl
        if (this._ttl) {
          q.ttl(this._ttl);
          this._ttl = null;
        }

        // set timestamp...
        q.timestamp(new Date().getTime());

        var self = this;
        this.cql(q.statement(), [], function(err, results){
            // console.log(q.statement(), err);
            if (err) return callback(err);
            self._created = true;
            callback(null, self);
        })
    };

    /**
        ModelArray.prototype.update

            Update the passed rows in the columnfamily by primary key

        @args - see ModelArray.prototype.set for parameter options


    **/
    ModelArray.prototype.update = function(rows, callback) {

        if (typeof(rows) === 'function'){
            callback = rows;
        } else {
            this.set(rows);
        }
        callback = callback || function(err, results){};

        var q = new CQL('ModelArray.prototype.update');
        q.update(this.__cfname);

        var args = {};
        _.each(this._rows, function(row){
            args[row.name] = row.value;
        })

        // set set args...
        q.set(args);
        q.where(ModelArray.keyAlias + '=:key', {key:this._key})

        // set consitency...
        q.consistency(this._options.consistency.update)

        // set ttl
        if (this._ttl) {
          q.ttl(this._ttl);
          this._ttl = null;
        }

        // set timestamp...
        q.timestamp(new Date().getTime());
        var statement = q.statement();
        var self = this;

        this.cql(statement, [], function(err, results){
            if (err) return callback(err);
            self._update=true;
            callback(null, self);
        });

    };

    /**
         ModelArray.prototype.delete

            Delete an an entire row by its key
            or a list of columns on key

        @rows   - optional rows to remove. (defaults to entire row)

    **/
    ModelArray.prototype.delete = function(columns, callback){

        if (typeof(columns) === 'function'){
            callback = columns;
            columns = [];
        }

        if (columns.constructor === String){
            columns = [columns]
        }

        callback = callback || function(err, results){};

        var q = new CQL('ModelArray.prototype.delete');
        q.delete(columns);
        q.from(this.__cfname);
        q.where(ModelArray.keyAlias + '=:key', {key:this._key});
        q.consistency(this._options.consistency.delete)

        // todo: set ttl...
        q.timestamp(new Date().getTime());

        var statement = q.statement();

        var self = this;
        this.cql(statement, [], function(err, results) {
            if (err) return callback(err, null);

            if (columns.length) {
                self._deleted = true;
            }
            callback(null, self);
        });
    };

    /**
        Model.prototype.incr - wrapper for Model.incr

    **/
    ModelArray.prototype.incr = function(col, i, callback){
        ModelArray.incr(this[ModelArray.primary()], col, i, callback)
    };

    /**
        Model.prototype.decr - wrapper for Model.incr

    **/
    ModelArray.prototype.decr = function(col, i, callback){
        ModelArray.decr(this[ModelArray.primary()], col, i, callback)
    };


    this.register(ModelArray);

    return ModelArray;

}

/**
 * Take an array of result rows and merge the columns into one row.
 * Mostly useful for sharded CFs.
 */
var mergeRows = exports.mergeRows = function (rows, desc) {
  var merged = [];
  var indices = [];

  for (var i = 0; i < rows.length; i++) {
    indices[i] = 0;
  }

  while (true) {
    for (i = 0, minIndex = null, minItem = null; i < rows.length; i++) {
      if (indices[i] >= rows[i].length) continue;

      var item = rows[i][indices[i]];
      if (!minItem || (desc && item.name > minItem.name || item.name < minItem.name)) {
        minItem = item;
        minIndex = i;
      }
      else if (item.name == minItem.name) {
        // Handle conflicting columns. If two rows have a col with the same
        // name, choose the column with the later timestamp and skip the one
        // with the earlier timestamp.
        if (item.timestamp < minItem.timestamp) {
          indices[minIndex] += 1;
          minItem = item;
          minIndex = i;
        }
        else {
          indices[i] += 1;
        }
      }
    }

    if (!minItem) break;

    merged.push(minItem);
    indices[minIndex] += 1;
  }

  return merged;
}

//////////////////


/*
    use this to auto-detect column family members???
*/
// var System = require('cassandra-client').System;
// var sys = new System('127.0.0.1:9160');
// sys.describeKeyspace('demo', function(err, def) {
//     _.each(def.cf_defs, function(cf){
//
//         _.each(cf.column_metadata, function(meta){
//             console.log(meta.name.toString(), meta.validation_class);
//         })
//
//     })
// });


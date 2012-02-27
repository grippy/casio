var Casio = require('../../').Casio;
var CQL = require('../../').CQL;

var Vote = require('./vote').Vote;
var Person = require('./person').Person;
var Pet = require('./pet').Pet;

var options = {

    host:'127.0.0.1', 
    port:9160, 
    keyspace:'casio',
    use_bigints: true,
    consistency:{
        select:'ONE',
        insert:'ONE',
        update:'ONE',
        delete:'ONE'
    }
}

var User = Casio.model('User', options);

User.connect();

User.property('userId', String, {
    primary:true
});

User.property('personId', Number, {});
User.property('name', String, {});
User.property('first_name', String, {});
User.property('last_name', String, {});
User.property('email', String, {});
User.property('birthday', String, {});
User.property('gender', String, {});
User.property('visits', Number, {});
User.property('is_admin', Boolean, {
    default:false
});


User.hasOne('person', Person, {
    // defaults
    // fk:'personId',
    // on:'personId'
});

User.hasMany('pets', Pet, {
    // defaults
    // fk:'personId',
    // on:'personId'
});

User.belongsTo('vote', Vote, {
    on:'key'
});

User.property('created_at', Date, {});
User.property('updated_at', Date, {});

User.classMethods({
    something:function(){
        return "this is something;"
    },
    
    getByEmail:function(email, callback){
        var q = new CQL('getByEmail');
        
        q.select(['*']);
        q.from('User');
        q.where('email=:email', {email:email});
        q.consistency(options.consistency.select);
        
        this.cql(q.statement(), [], function(err, users){
            callback(err, users)
        })
    }



});

User.instanceMethods({
    hello:function(){
        return 'Hello, ' + this.first_name + ' ' + this.last_name + ' (' + this.email + ')';
    }
    
});


//////////////////////////////////////
exports.User = User
//////////////////////////////////////
// short version of user
function UserShort(props){
    this._type = 'UserShort';
    
    for(p in props){
        this[p] = props[p];
    }
}

UserShort.prototype = {
    _type:null,
    first_name:null,
    last_name:null
}
UserShort.prototype.hello = function(){
    return 'Hello, ' + this.first_name + ' ' + this.last_name ;
}

//////////////////////////////////////
exports.UserShort = UserShort
//////////////////////////////////////
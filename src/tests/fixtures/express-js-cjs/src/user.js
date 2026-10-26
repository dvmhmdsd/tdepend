const db = require('./db');

module.exports = {
  find: () => db.users,
};

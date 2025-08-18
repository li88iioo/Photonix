const { v4: uuidv4 } = require('uuid');

function requestId() {
  return (req, res, next) => {
    const id = req.headers['x-request-id'] || uuidv4();
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

module.exports = requestId;



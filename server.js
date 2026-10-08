const express = require("express");
const fs = require("fs");
const app = express();
const PORT = 3000;

app.use(express.static("public"));

app.get("/api/haine", (req,res) => {
    const text = fs.readFileSync("haine.json", "utf8");
    const haine = JSON.parse(text);
    res.json(haine);
});

app.listen(PORT, () => {
    console.log("Serverul merge pe http://localhost:" + PORT);

});
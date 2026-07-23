const { handler } = require("./netlify/functions/audit.js");

(async () => {
  const url = process.argv[2] || "http://127.0.0.1:8899";
  const event = { queryStringParameters: { url } };
  const res = await handler(event);
  const body = JSON.parse(res.body);
  console.log("statusCode:", res.statusCode);
  console.log("score:", body.score, "grade:", body.grade);
  console.log("categories:", body.categories);
  for (const c of body.checks) {
    console.log(`${c.name}: ${c.points}/${c.max}`);
  }
})();

const path = require("path");

const { closePool, executeSqlFile } = require("./postgres");


async function main() {
  const schemaPath = path.join(__dirname, "schema.sql");
  await executeSqlFile(schemaPath);

  console.log(JSON.stringify({
    ok: true,
    schemaPath,
  }, null, 2));
}


main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const { seedDemo, bootstrapAdmin, DEMO_PASSWORD } = require('./seed');

async function main() {
  await db.init();
  console.log(`Database: ${db.getMode()}`);

  if (await bootstrapAdmin()) console.log('Created first administrator from ADMIN_USERNAME / ADMIN_PASSWORD');

  if (config.seedDemo) {
    const seeded = await seedDemo();
    if (seeded) {
      console.log('Seeded SIMULATED demo data. Demo accounts' + (config.isProd ? ' (password set via DEMO_PASSWORD):' : ' (password: ' + DEMO_PASSWORD + '):'));
      console.log('  admin, mine_solwezi, mine_mufulira, mine_kalumbila, trans_copperbelt,');
      console.log('  wb_kitwe, insp_ndola, reg_zra, buyer_alpine, buyer_shenzhen');
    }
  }

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Mineral Traceability prototype running on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

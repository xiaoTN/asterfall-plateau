import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests',testMatch:'**/*.e2e.ts',testIgnore:'**/production.e2e.ts',timeout:120000,expect:{timeout:12000},fullyParallel:false,workers:1,
  reporter:[['list']],use:{baseURL:'http://127.0.0.1:5174',viewport:process.env.CI?{width:1280,height:720}:{width:1440,height:900},
    // Shared CI runners use the game's normal low graphics setting, without
    // granting items/progress or changing the simulation and collision rules.
    storageState:process.env.CI?{cookies:[],origins:['http://127.0.0.1:5174','http://127.0.0.1:5187'].map(origin=>({origin,localStorage:[{name:'asterfall.settings.v1',value:'{"quality":"low"}'}]}))}:undefined,
    headless:true,screenshot:'only-on-failure',trace:'retain-on-failure',launchOptions:{args:['--enable-webgl','--ignore-gpu-blocklist','--use-angle=swiftshader','--enable-unsafe-swiftshader']}},
  webServer:{command:'npm run dev -- --port 5174 --strictPort --mode test',url:'http://127.0.0.1:5174',reuseExistingServer:true,timeout:60000},
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const VERSION = '20260828-rpo-v1';
const browserFiles = [
  'index.html', 'src/main.js', 'src/scene.js', 'src/robot/RobotBuilder.js',
  'src/robot/description.js', 'src/robot/Actuators.js', 'src/robot/urdfExport.js',
  'src/control/MotionController.js', 'src/control/BalanceController.js',
  'src/control/behaviors.js', 'src/ui/HUD.js', 'src/ui/TrainPanel.js',
  'src/rl/nn.js', 'src/rl/ppo.js', 'src/rl/BalanceEnv.js',
  'src/rl/Trainer.js', 'src/rl/trainWorker.js', 'src/rl/PolicyBalancer.js',
];

test('浏览器本地模块使用统一版本号，避免新旧 ES Module 缓存混载', async () => {
  for (const file of browserFiles) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const localRefs = [...source.matchAll(/(?:from\s+|src=)["'](\.{1,2}\/[^"']+)["']/g)];
    for (const match of localRefs) {
      assert.ok(match[1].endsWith(`?v=${VERSION}`),
        `${file} 的本地模块 ${match[1]} 缺少统一版本号`);
    }
  }
});

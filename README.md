# 宇树风格人形机器人 · Three.js

一个用 Three.js 构建的高细节人形机器人，重点在**控制系统**：基于 IK 的步态、行为状态机、类 PD 的关节平滑。模型采用陶瓷白分片装甲、黑色机械骨架、金属关节、独立传感器面罩、机械手与流线型腿甲，并配有展示级灯光和地台。

## 运行

无需打包工具，需一个静态服务器（因为用了 ES Module + importmap）：

```bash
npx http-server -p 5179 -c-1 .
# 然后浏览器打开 http://localhost:5179
```

或者用 VS Code 的 Live Server 插件打开 `index.html`。

> 直接双击 `index.html`（file://）会因 CORS 加载不了模块，必须走 http。

## 操作

- 面板按钮：**站立 / 走路 / 跳舞 / 八段锦 / 挥手 / 跳跃**
- **八段锦**：按传统八式完成约 64 秒循环；自动播放 72 BPM 五声音阶古琴/洞箫风格伴奏，可独立静音
- 滑块：步速、步幅、转向、连续镜头距离（1.5–7.0m）
- 键盘：`W` 前进（自动切走路）、`A/D` 转向、`空格` 跳跃
- 鼠标拖拽旋转视角；「跟随」让相机跟住机器人；「骨架」显示关节点

当前机器人名义高度约 **1.53m**；默认站姿采用自然前摆肩和向前屈肘。

## 架构

```
index.html              入口 + importmap + HUD 布局
styles.css              界面样式
src/
  main.js               场景装配 + 主循环
  scene.js              渲染器 / 相机 / 灯光 / 地面 / 轨道控制
  robot/
    skeleton.js         机器人尺寸参数（仿 G1 比例）
    RobotBuilder.js     高细节程序化建模：分层装甲 / 机械骨架 / 关节 / 五指机械手
  control/
    MathUtils.js        插值、阻尼平滑、两骨解析 IK（核心数学）
    behaviors.js        行为：Idle / Walk / Dance / Baduanjin / Wave / Jump
    MotionController.js  关节平滑 + 行为状态机 + 根节点运动
  audio/
    ClassicalMusic.js   Web Audio 五声音阶古典风格实时伴奏
  ui/
    HUD.js              面板与键盘绑定
```

### 控制系统三层

1. **骨骼层**：`Object3D` 层级枢轴（pelvis → waist → 头/肩/髋 → 肘/膝 → 踝）。
2. **控制层（重点）**
   - **MotionController**：保存每关节当前角，每帧朝目标角做与帧率无关的阻尼平滑（`damp = lerp(cur,tgt,1-e^(-dt/τ))`，类临界阻尼 PD）。动作切换因此天然平滑。
   - **两骨 IK**（`solveLegIK`）：由"脚的目标位置"用余弦定理反解髋/膝角，是步态的基础。
   - **行为状态机**：每个行为每帧产出目标姿态 + 根运动（前进速度、重心高度/起伏）。
3. **表现层**：建模、灯光阴影、HUD、跟随相机。

### 步态原理（WalkBehavior）

- 相位时钟驱动，左右腿相差半周期。
- 占空比 `duty=0.62`：支撑相脚贴地匀速后移（身体前进），摆动相脚抬起按摆线回到前方。
- 骨盆 2× 频率上下起伏 + 1× 频率横向摆向支撑腿，躯干略前倾，手臂与腿反相摆动。
- 前进速度与步频×步幅匹配，减少脚底打滑。

## 可调参数

- `src/robot/skeleton.js`：肢体长度、站高、肩宽等比例。
- `src/control/behaviors.js`：`KNEE_SIGN`（膝弯方向）、`duty`、`stepHeight`、舞蹈编排。
- `src/control/MotionController.js`：`tau`（各部位响应速度）。

## 扩展方向

- 把解析 IK 换成带地面约束的足端轨迹规划，彻底消除打滑。
- 加入简易物理（重心 + ZMP 平衡）让站立/跳跃有反馈。
- 用 `GLTFLoader` 加载真实宇树模型并把本控制系统驱动其骨骼。
- 录制/回放动作序列，做动作编辑器。

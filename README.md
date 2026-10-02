# 宇树风格人形机器人 · Three.js

一个用 Three.js 构建的高细节人形机器人，重点在**控制系统**：基于 IK 的步态、行为状态机、重力感知的 LIPM 重心动力学、ZMP 闭环平衡和真实执行器伺服。v2.x 加入 HDR Bloom 渲染管线、可变表情的面部灯光、手腕与铰接五指、跑步腾空步态、后空翻和功夫连招，机器人在待机时还会注视镜头、眨眼。

**v2.4 工程级建模**：整机按"关节表 → 执行器模组 → 结构件 → 外壳 → 线束/电子"逐层程序化装配，1450 个零件、31 台按电机档位定尺寸的关节模组：

| 层 | 实现 |
|---|---|
| 执行器 | 每个关节一台模组（J120 / J27 / J9 三档外形），定子归父刚体、输出法兰与螺栓圈归子刚体，转动时只有法兰在转；外壳负载环按 \|τ\|/τmax 实时变色（青→琥珀→红，力矩饱和时泛红光） |
| 串联关节链 | 髋 / 肩 / 腰 / 颈 / 腕的多轴 Group 按真实串联顺序（如髋 pitch→roll→yaw）重新做欧拉分解，中间级支架与电机按分解角运动，末级姿态与伺服层输出严格一致 |
| 并联踝 | 小腿上两台 J27 经 42mm 曲柄 + 连杆推动足部，每帧由闭环方程 `Dy·cosθ + Dz·sinθ = K` 解析求曲柄角；全行程（pitch −1.0~0.85、roll ±0.3 rad）可达、杆长误差 < 1µm |
| 外壳 | 超椭圆放样（`\|x/a\|ⁿ + \|z/b\|ⁿ = 1`）的分体壳，带真实壁厚和 3mm 分模缝：胸甲上下分体、侧甲带散热格栅、背部快拆电池包 |
| 内部 | 主控板 + SoC 散热器 + 风扇、铜母排配电板、IMU、脊柱减重侧板、碳纤维梁、编织套管线束 |
| 头部 | 曲面烟色面罩 + 7×5 LED 点阵双眼（六种表情由解析形状逐像素采样，可眨眼 / 渐变 / 闪光）、双目深度相机、耳部麦克风阵列、后置激光雷达 |
| 手 | 四指三节 + 两节对掌拇指，胶囊指节 + 铝销轴 + 掌侧 TPU 垫 |
| 材质 | PBR 物理材质 + 运行时生成的微观纹理（注塑砂纹、喷砂铝、拉丝铝、碳纤维斜纹、编织套管、足底防滑纹），零贴图资源 |
| 渲染 | AgX 色调映射 + GTAO 环境光遮蔽 + 阴影相机跟随（≈1.6mm/texel）；同刚体同材质零件合批，整机约 400 个网格 |
| 工程视图 | X 光全息透视、爆炸视图、执行器悬停检视（关节名 / 档位 / 实时角度、力矩、限位、kp/kd） |

**v2.3 工业化升级**（架构对标开源实机项目 [Roboparty roboto_origin](https://github.com/Roboparty/roboto_origin)）：

| 本项目模块 | roboto_origin 对应 | 内容 |
|---|---|---|
| `src/robot/description.js` | `rpo_description` | 单一事实来源的关节表：31 个单轴关节（23 个与 rpo.urdf 同名对齐），轴向/限位/电机档位/伺服增益/连杆质量 |
| `src/robot/Actuators.js` | `roboparty_firmware` | 500Hz 关节伺服：PD → 力矩饱和（髋膝 120N·m）→ 速度限幅 → 机械硬限位，行为层只下发目标角 |
| `src/robot/urdfExport.js` | `rpo_description/urdf` | 一键导出标准 URDF（31 关节 / 32 连杆 / 惯量），可直接进 MuJoCo、Isaac Lab、PyBullet |
| `src/rl/` | `roboparty_train`（rsl_rl + Isaac Lab） | 纯 JS PPO + 域随机化平衡环境，浏览器后台 Worker 训练，一键部署替换手调 PD |

## 运行

无需打包工具，需一个静态服务器（因为用了 ES Module + importmap）：

```bash
npm start
# 等价于 npx http-server -p 5179 -c-1 .，然后浏览器打开 http://localhost:5179
```

或者用 VS Code 的 Live Server 插件打开 `index.html`。

> 直接双击 `index.html`（file://）会因 CORS 加载不了模块，必须走 http。

运行回归测试（动力学、运动学、强化学习、整机建模）：

```bash
npm install   # 仅安装 three，供 Node 端装配整机模型做建模测试
npm test
```

建模测试会在 Node 里装配完整机器人，检查：接口与关节枢轴位置、31 台执行器与关节表一一对应、站姿足底贴地（误差 < 6mm）、串联级分解正确、踝连杆全行程闭环、所有法线有限（防 NaN 经 Bloom 扩散成黑屏）、网格与三角面预算、爆炸 / X 光可逆。

## 操作

- 面板按钮：**站立 / 走路 / 跑步 / 跳舞 / 八段锦 / 功夫 / 挥手 / 跳跃 / 后空翻**
- 键盘：`W/S` 前进后退（自动切走路）、`A/D` 转向、`Shift` 冲刺跑、`空格` 跳跃、`F` 后空翻、`K` 功夫
- 滑块：步速、步幅、转向、连续镜头距离（1.5–7.0m）
- 鼠标拖拽旋转视角；「跟随」让相机跟住机器人；「骨架」显示关节点
- 「扰动测试」施加水平冲量；「平衡：开/关」可直接对比闭环控制效果
- 地面绿色轮廓为当前支撑域，圆点显示重心投影（COM）与零力矩点（ZMP）；底部显示稳定裕度（跑跳类动作显示「动态」）
- **强化学习**：「训练：开」在后台 Worker 起 16 个并行环境跑 PPO，实时画回合回报曲线；「控制器：PD/RL」把训练出的策略热部署到平衡环（用扰动测试对比两者恢复效果）；权重可导出/导入 JSON
- **工程**：「导出 URDF」下载可进 MuJoCo / Isaac Lab 的机器人描述文件；「关节监视」实时显示全部 31 个关节的角度、力矩负载比、饱和（⚠）与限位（⛔）状态
- **工程视图**：「X 光透视」把外壳换成菲涅尔全息材质，露出执行器、结构件、电池和线束；「爆炸视图」/「分解」滑块把 37 块外壳沿各自方向分解；鼠标悬停任意关节模组显示电机档位与实时遥测
- **八段锦**：按传统八式完成约 64 秒循环，自动播放 72 BPM 五声音阶古琴/洞箫风格伴奏，可独立静音

### 招牌动作

- **后空翻**：深蹲蓄力 → 爆发起跳 → 空中团身后旋 360° → 展体落地缓冲。腾空高度由弹道方程决定，落地后姿态角自动归一。
- **功夫连招**：抱拳礼 → 撤步沉马 → 左右冲拳（腰马合一）→ 弓步双推掌 → 右侧踢 → 收势，全程握拳/立掌切换，眼睛转为赤红。
- **跑步**：占空比 0.42 产生真实双脚离地腾空相，躯干前倾、屈肘摆臂、松握拳。

### 面部表情系统

面罩上的 LED 点阵随行为切换表情形状与颜色：待机冰蓝 / 行走深蓝 / 跑跳琥珀 / 功夫赤红 / 八段锦翠绿 / 跳舞霓虹粉；发力瞬间（起跳、冲拳）眼部闪光。待机时头部自动注视镜头，并随机眨眼。

当前机器人名义高度约 **1.53m**；默认站姿采用自然前摆肩和向前屈肘。

## 架构

```
index.html              入口 + importmap + HUD 布局
styles.css              界面样式
src/
  main.js               场景装配 + 主循环 + 平衡可视化
  scene.js              渲染器 / HDR Bloom 后期 / 环境反射 / 灯光 / 展示台
  robot/
    skeleton.js         机器人尺寸参数（仿 G1 比例）
    RobotBuilder.js     ★ 整机装配：骨盆 / 腰 / 躯干 / 头 / 臂 / 腿 / 足 + 串联级 + 并联踝 + 工程视图
    model/
      loftCore.js       ★ 纯数学几何内核：超椭圆放样（壁厚 / 分体 / 穹顶）、曲柄连杆闭环解（可在 Node 单测）
      geometry.js       three 几何工具：肢体壳、车削件、带减重孔的机加工板、线束管、螺钉
      materials.js      PBR 材质库 + 程序化微观纹理 + X 光全息材质 + 铭牌 / 警示贴花
      components.js     标准件：执行器模组（按电机档位）、螺栓圈、轴承座、风扇、格栅、贴花
      PartSink.js       刚体 × 材质合批 + 退化法线清洗
      Face.js           LED 点阵面部表情
      Hand.js           灵巧手（三节指 + 对掌拇指）
    description.js      ★ 关节表 / 电机档位 / 限位 / 连杆质量（对齐 rpo_description）
    Actuators.js        ★ 500Hz 关节伺服层：PD + 力矩/速度/限位三重约束（对齐 roboparty_firmware）
    urdfExport.js       ★ 标准 URDF 导出（对齐 rpo_description/urdf）
  control/
    MathUtils.js        插值、阻尼平滑、两骨解析 IK（核心数学）
    BalanceController.js  9.81m/s² 重力、LIPM、支撑域/捕获点判稳、ZMP-PD 闭环 + RL 策略钩子
    behaviors.js        行为：Idle / Walk / Run / Dance / Baduanjin / Wave / Jump / Backflip / Kungfu
    MotionController.js  行为状态机 + 执行器伺服驱动 + 根节点运动 + 表情/手指驱动 + 注视
  rl/                   ★ 强化学习（对齐 roboparty_train / rsl_rl）
    nn.js               零依赖 MLP + 手写反传 + Adam
    ppo.js              PPO-Clip + GAE + KL 早停 + 熵正则
    BalanceEnv.js       域随机化平衡环境（LIPM、50Hz、动作延迟、观测噪声、随机推撞）
    Trainer.js          并行采样 + 模仿学习热启动 + critic 预热 + 最优 checkpoint + 发散回滚
    trainWorker.js      Web Worker 后台训练（渲染零卡顿）
    PolicyBalancer.js   策略部署适配器（sim2sim：训练/部署共用同一观测构造）
  audio/
    ClassicalMusic.js   Web Audio 五声音阶古典风格实时伴奏
  ui/
    HUD.js              面板与键盘绑定 + URDF 导出 + 关节遥测
    TrainPanel.js       ★ RL 训练面板：曲线 / 部署切换 / 权重导入导出
    Inspector.js        ★ 工程视图：X 光 / 爆炸视图 / 建模统计 / 执行器悬停检视
```

### 控制系统四层（对齐实机分层）

1. **骨骼层**：`Object3D` 层级枢轴（pelvis → waist → 头/肩/髋 → 肘/膝 → 腕/踝 → 指）。
2. **执行器层（v2.3 新增）**：`description.js` 定义 31 个单轴关节（命名与 rpo.urdf 对齐：`left_thigh_pitch_joint`、`torso_joint`…），每个关节由 `Actuators.js` 以 500Hz 固定步长仿真电机伺服：`τ = kp·(q*−q) − kd·q̇` → 力矩饱和（髋/膝/腰 120N·m，踝/肩/肘 27N·m，借鉴 rpo 电机规格）→ 驱动器速度限幅 → 机械硬限位。行为层不再直接写关节角，只下发目标；kp/kd 由反射惯量与期望闭环频率解析（`kp=Iω²`）。
3. **控制层（重点）**
   - **MotionController**：行为状态机产出目标姿态，叠加平衡反馈后交给执行器层。空翻等快动作可通过 `pitchTau/heightTau` 覆盖根姿态平滑常数；根 pitch 做角度环绕归一，±2π 旋转结束后不会反向回卷。
   - **两骨 IK**（`solveLegIK`）：由"脚的目标位置"用余弦定理反解髋/膝角，是步态的基础。
   - **重力平衡**（`BalanceController`）：使用标准重力 `9.81m/s²` 和线性倒立摆模型推进重心；由接触足计算支撑多边形，以捕获点到边界的最小距离作为稳定裕度；ZMP-PD 控制输出受真实足底边界限制。
   - **行为状态机**：每个行为每帧产出目标姿态 + 根运动 + 表情/手势；跳跃、空翻、功夫是一次性行为，播完自动回站立。
4. **机构层（v2.4 新增）**：`rig.update()` 在伺服写回关节角之后同步串联中间级、解算踝并联连杆、按遥测给执行器负载环着色。
5. **表现层**：工程级建模、AgX + GTAO + HDR Bloom（阈值 7，只有 LED 泛光）、环境反射、跟随阴影、HUD、跟随相机。

### 强化学习管线（对齐 roboparty_train）

```
BalanceEnv (50Hz LIPM + 域随机化)  ←  训练与部署同一套动力学（sim2sim 思路）
   │  观测(10)：重心/速度/捕获点/上步动作/支撑域尺寸
   │  动作(2)：归一化 ZMP 指令（≈踝力矩）
   │  奖励：存活 + 回中 − 速度 − 动作幅度 − 动作率（Isaac Lab 加权项风格）
   │  随机化：重心高度、支撑域、观测噪声、1 步动作延迟、随机推撞
   ▼
Trainer (Web Worker, 16 并行环境 × 128 步/迭代)
   1. 模仿学习热启动：监督克隆 PD 专家（prevA 与目标解耦防"抄近路"）
   2. critic 预热 15 迭代（冻结 actor，防噪声优势毁掉示教策略）
   3. PPO-Clip + GAE + KL 早停（desired-KL 0.02）+ 熵下限
   4. 最优 checkpoint 跟踪 + 发散自动回滚（跌破最优 40% 连续 8 迭代 → 恢复权重、降 lr）
   ▼
PolicyBalancer → BalanceController.zmpPolicy 钩子（确定性均值动作热部署，PD ↔ RL 随时切换）
```

离线基准（20 回合 × 500 步，固定 0.25m/s 推撞）：无控制存活 20 步，手调 PD 与 RL 最优 checkpoint 均满时长存活（回报 491.8 vs 491.0）；RL 额外在域随机化（±20% 参数摄动 + 延迟 + 噪声）下训练，鲁棒性来源于此。

### 步态原理

- **走路**（duty 0.90）：延长双支撑期并提前把重心预载到下一条支撑腿，摆动相脚按摆线回到前方；支持倒退（`S`）与转弯侧倾。
- **跑步**（duty 0.42）：单脚支撑窗之间出现真实腾空相，重心随弹道抬升；平衡环在腾空段自动切换为动量守恒。
- 骨盆 2× 频率上下起伏 + 1× 频率横向摆向支撑腿，手臂与腿反相摆动，前进速度与步频×步幅匹配。

## 可调参数

- `src/robot/skeleton.js`：肢体长度、站高、肩宽等比例。
- `src/robot/RobotBuilder.js`：各部位外壳截面关键帧 `[y, 半宽, 半深, 前后偏心, 方度]`、支架与内部件布局、`crankRadius` 踝曲柄半径。
- `src/robot/model/components.js`：`ACTUATOR_SIZE` 各档电机外形。
- `src/robot/model/materials.js`：材质与程序化纹理。
- `src/robot/model/Face.js`：`EMOTIONS` 表情色板、`SHAPES` 点阵表情形状。
- `src/control/behaviors.js`：`KNEE_SIGN`、走/跑 `duty`、`stepHeight`、舞蹈编排、功夫连招段落（`makeKungfuSegments`）。
- `src/control/MotionController.js`：`tau`（各部位响应速度）。
- `src/scene.js`：色调映射、GTAO、Bloom 强度/阈值、灯光、展示台。

> 注意：Bloom 阈值（7，按亮度）与 LED 亮度配套：LED 按"目标亮度 / 颜色亮度系数"归一，金属镜面高光峰值实测 < 10 且面积很小。调亮灯光或调低阈值会让金属件出现光斑。
> 铝材质刻意不使用 `anisotropy`：小车削件 UV 退化时各向异性切线会产生 Inf 高光并被 Bloom 扩散成大片光斑。

## 动力学边界

当前实现是实时、确定性的简化动力学，并非全身刚体接触求解器。已进入闭环的：重力、重心加速度（LIPM）、足底约束、失稳检测、每关节的电机力矩饱和/速度限幅/机械限位（500Hz 伺服）。尚未建模的：全身刚体惯量耦合、摩擦锥、自碰撞与摔倒后的地面碰撞。空翻的翻转角速度是编排的（保证整周落地），不是由角动量守恒解算的。RL 训练发生在与部署一致的 LIPM 模型上（sim2sim），不是全身动力学。

## 通往真实机器人

- 「导出 URDF」得到的 `rpo_web_humanoid.urdf` 可直接 `roslaunch` 进 RViz、导入 MuJoCo（`compile` 自动转 MJCF）或 Isaac Lab——把浏览器里的比例/限位/电机配置一键带进真实工具链。
- 关节命名与 [roboto_origin](https://github.com/Roboparty/roboto_origin) 的 `rpo.urdf` 对齐，其 `roboparty_train` 的 IsaacLab 训练脚本和 `sim2sim_rpo.py` 流程可以低成本迁移。
- `src/rl` 的观测/动作/奖励设计与 Isaac Lab velocity 任务同构，权重 JSON 里就是纯 MLP 参数，可无损转 PyTorch。

## 扩展方向

- 把解析 IK 换成带地面约束的足端轨迹规划，彻底消除打滑。
- 接入 Rapier/Ammo 等刚体引擎，把 RL 环境从 LIPM 升级为全身动力学（观测/动作接口不变）。
- RL 任务从平衡恢复扩展到速度跟踪步态（Isaac Lab locomotion 同款奖励已是现成模板）。
- 把程序化模型按刚体导出为 glTF / STL，作为 URDF 的 visual mesh（当前 URDF 仍用包围盒）。
- 录制/回放动作序列，做动作编辑器。
- 侧空翻/旋风踢等更多杂技动作（复用 `SequenceBehavior` 序列器）。

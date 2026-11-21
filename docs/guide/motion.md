# 插件页面动效规范

适用于插件自己的面板页。框架提供了一套动效预设，优先复用它，页面风格才会和控制台一致。预设定义在 `packages/panel-ui/src/motion.ts`，组件已经内置了大部分常用场景，插件页通常只需要处理列表和区块进场。

## 原则

1. 优先使用导出的预设：`spring`、`softSpring`、`snappy`、`stagger`、`staggerItem`、`useFadeUp`。
2. 动效表达空间关系（从哪来、到哪去），不做纯装饰的循环动画。
3. 动效必须可中断；快速连续操作时不能卡住或叠影。
4. 尊重 `prefers-reduced-motion`，减少动效时保留透明度变化、去掉位移。
5. 优先动画 `transform`、`opacity` 和少量 `filter`，不动布局属性。

## 依赖

`@asabot/panel-ui` 已经依赖 `motion`，但插件如果直接写 `import { motion } from 'motion/react'`，需要在插件自己的 `package.json` 里声明 `motion`，不要依赖宿主或依赖提升。只用组件内置动效时不需要额外声明。

## 预设

| 预设 | 参数 | 用途 |
| --- | --- | --- |
| `spring` | stiffness 420 / damping 34 / mass 0.8 | 有明确落点的位移：Tab 指示条、弹窗进场 |
| `softSpring` | stiffness 260 / damping 30 | 较大位移：抽屉、列表和区块进场 |
| `snappy` | stiffness 600 / damping 38 | 即时反馈：按钮按压、开关、微交互 |
| `stagger` + `staggerItem` | 子项间隔 0.035s | 列表批量入场 |
| `useFadeUp` | `softSpring`，自动处理 reduced-motion | 单个区块淡入上移 |
| `NumberTicker` | `snappy` 调整为 stiffness 120 / damping 24 | 数字变化滚动 |

## 场景与预设

| 场景 | 做法 | 说明 |
| --- | --- | --- |
| 按钮按压 | `whileTap={{ scale: 0.97 }}` + `snappy` | `Button` 已内置，不要重复包一层 |
| 开关切换 | `layout` + `snappy` | `Switch` 已内置 |
| Tab / 分段指示器 | `layoutId` + `spring` | `Tabs`、`PageTabs`、`Segmented` 已内置 |
| 弹窗进场 | `spring`，遮罩淡入 0.2s | `Dialog` 已内置 |
| 右侧抽屉 | `softSpring` 横向位移 | `Sheet` 已内置 |
| 列表入场 | `stagger` + `staggerItem` | 只给容器加，子项用 variants |
| 空状态出现 | `softSpring` | `EmptyState` 已内置 |
| 单个区块出现 | `useFadeUp()` | 用于不在列表里的卡片 |
| 数字变化 | `NumberTicker` | 不要自己用 CSS 过渡数字 |
| 加载 shimmer | `Skeleton` | 减少动效时自动关闭 |

## 编写方式

列表入场：

```tsx
import { motion } from 'motion/react'
import { stagger, staggerItem } from '@asabot/panel-ui'

function ItemList({ items }: { items: Item[] }) {
  return (
    <motion.ul initial="initial" animate="animate" variants={stagger}>
      {items.map((item) => (
        <motion.li key={item.id} variants={staggerItem}>
          {item.name}
        </motion.li>
      ))}
    </motion.ul>
  )
}
```

单个区块：

```tsx
import { motion } from 'motion/react'
import { useFadeUp } from '@asabot/panel-ui'

function SummaryCard({ children }: { children: ReactNode }) {
  const fadeUp = useFadeUp()
  return <motion.section {...fadeUp}>{children}</motion.section>
}
```

`PanelUIProvider` 已经设置 `MotionConfig reducedMotion="user"`，它作用于 Provider 子树里的所有 Motion 组件，包括你写的。所以通常不需要手动判断；只有组件不在 Provider 下，或者需要在减少动效时改变动画结构（而不只是禁用位移）时，才用 `useReducedMotion()`：

```tsx
import { motion, useReducedMotion } from 'motion/react'

function Banner() {
  const reduced = useReducedMotion()
  return (
    <motion.div
      initial={{ opacity: 0, y: reduced ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
    />
  )
}
```

## 常见问题

以下是实际容易出问题的点：

- 长列表逐项使用 spring 或 `layoutId`，滚动和更新会掉帧。用 `stagger` 只给容器加，或者只给首屏少量元素加。
- 给已经内置动效的组件（`Button`、`Switch`、`Dialog`、`Tabs`）再包一层动画，会出现重复或叠加的位移。
- 装饰性无限循环动画会持续占用 GPU，也让界面显得吵。只有加载、骨架屏和状态点适合循环。
- 自定义参数时位移和缩放过大、时长过长，会和面板其他部分脱节。建议位移控制在 8–12px、缩放不超过 1.05、进出场不超过 400ms。
- 用动效掩盖慢加载；慢的地方先优化数据加载或用骨架屏。

## 减少动效与性能

- CSS 动画用 `motion-safe:` 前缀或 `@media (prefers-reduced-motion: reduce)` 关闭。
- 减少动效时保留透明度过渡，去掉位移、缩放和模糊。
- 只动画 `transform` / `opacity` / 小范围 `filter`；不要动画 `width`、`height`、`top`、`left`。
- 图表和数字使用组件自带过渡，不要在外面再包一层动画。
- 动效多时在低端设备和窄屏上实际滚动一遍，确认没有明显掉帧。

## 验收清单

- [ ] 优先使用导出预设，自定义参数有明确理由
- [ ] 开启系统「减少动效」后没有位移和缩放，内容仍然可见
- [ ] 快速连点、快速切换 Tab 时不卡顿、不叠影
- [ ] 弹窗、抽屉、列表的观感一致
- [ ] 没有装饰性无限循环动画
- [ ] 长列表滚动和图表更新流畅

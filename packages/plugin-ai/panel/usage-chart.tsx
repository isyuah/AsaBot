import { BarChart, type BarSeriesOption } from 'echarts/charts'
import {
  GridComponent,
  type GridComponentOption,
  TooltipComponent,
  type TooltipComponentOption,
} from 'echarts/components'
import { type ComposeOption, type EChartsType, init, use } from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { useEffect, useRef } from 'react'
import type { UsageReport } from '../src/contracts.ts'
import { number } from './ui.tsx'

use([BarChart, GridComponent, TooltipComponent, SVGRenderer])

type Options = ComposeOption<BarSeriesOption | GridComponentOption | TooltipComponentOption>

function optionsFor(daily: UsageReport['daily'], style: CSSStyleDeclaration, reduced: boolean): Options {
  const color = (name: string) => style.getPropertyValue(`--${name}`).trim()
  const axisLabel = { color: color('fg-2'), fontSize: 11 }

  return {
    animation: !reduced,
    animationDuration: 320,
    animationDurationUpdate: 220,
    textStyle: { fontFamily: style.fontFamily },
    grid: { top: 16, right: 8, bottom: 0, left: 0, outerBoundsMode: 'auto' },
    xAxis: {
      type: 'category',
      data: daily.map(({ day }) => day),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: color('border-strong') } },
      axisLabel: { ...axisLabel, margin: 10, hideOverlap: true, formatter: (day: string) => day.slice(5) },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      splitNumber: 4,
      axisLabel: { ...axisLabel, formatter: (value: number) => number.format(value) },
      splitLine: { lineStyle: { color: color('border'), type: 'dashed' } },
    },
    tooltip: {
      trigger: 'axis',
      renderMode: 'richText',
      confine: true,
      transitionDuration: reduced ? 0 : 0.15,
      backgroundColor: color('surface'),
      borderColor: color('border'),
      borderWidth: 1,
      textStyle: { color: color('fg'), fontFamily: style.fontFamily, fontSize: 12 },
      axisPointer: { type: 'shadow', shadowStyle: { color: color('surface-3'), opacity: 0.32 } },
      valueFormatter: (value) => `${number.format(Number(value))} 次`,
    },
    series: [
      {
        type: 'bar',
        name: '已结束调用',
        data: daily.map(({ requests }) => requests),
        barMaxWidth: 28,
        itemStyle: { color: color('series-in'), borderRadius: [4, 4, 0, 0] },
        emphasis: { itemStyle: { color: color('accent-hover') } },
      },
    ],
  }
}

export default function UsageChart({ daily }: { daily: UsageReport['daily'] }) {
  const container = useRef<HTMLDivElement>(null)
  const instance = useRef<EChartsType>(null)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const chart = init(element, undefined, { renderer: 'svg' })
    instance.current = chart
    const resize = new ResizeObserver(() => chart.resize())
    resize.observe(element)
    return () => {
      resize.disconnect()
      chart.dispose()
      instance.current = null
    }
  }, [])

  useEffect(() => {
    const chart = instance.current
    const element = container.current
    if (!chart || !element) return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => chart.setOption(optionsFor(daily, getComputedStyle(element), preference.matches))
    const theme = new MutationObserver(update)
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    })
    preference.addEventListener('change', update)
    update()
    return () => {
      theme.disconnect()
      preference.removeEventListener('change', update)
    }
  }, [daily])

  const peak = Math.max(...daily.map(({ requests }) => requests))
  return (
    <div
      ref={container}
      className="ai-usage-chart"
      role="img"
      aria-label={`每日已结束调用量，单日最多 ${number.format(peak)} 次`}
    />
  )
}

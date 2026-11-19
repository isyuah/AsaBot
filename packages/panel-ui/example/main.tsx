import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  Field,
  Input,
  MessageChart,
  PanelUIProvider,
  PluginPageLayout,
  Switch,
} from '@asabot/panel-ui'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@asabot/panel-ui/styles.css'
import './style.css'

const minute = 60_000
const now = Math.floor(Date.now() / minute) * minute
const points = Array.from({ length: 60 }, (_, i) => ({
  t: now - (59 - i) * minute,
  received: 6 + ((i * 7) % 11),
  sent: 3 + ((i * 3) % 8),
}))
const messages = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  text: `消息 ${i + 1}`,
  sent: i % 3 === 0,
}))

function App() {
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState(true)
  const [details, setDetails] = useState(false)
  const visible = messages.slice(0, expanded ? messages.length : 2).filter((row) => row.text.includes(filter))

  return (
    <PluginPageLayout
      toolbar={
        <div className="toolbar">
          <Field label="筛选消息" htmlFor="message-filter">
            <Input id="message-filter" value={filter} onChange={(event) => setFilter(event.target.value)} />
          </Field>
          <Button variant="secondary" onClick={() => setDetails(true)}>
            统计详情
          </Button>
        </div>
      }
    >
      <div className="content">
        {expanded && (
          <Card>
            <CardHeader title="最近一小时" />
            <MessageChart points={points} range="1h" />
          </Card>
        )}
        <Card>
          <CardHeader
            title="消息列表"
            action={<Switch aria-label="显示完整列表" checked={expanded} onCheckedChange={setExpanded} />}
          />
          {visible.length === 0 ? (
            <p className="message">没有匹配的消息</p>
          ) : (
            <ul>
              {visible.map((row) => (
                <li key={row.id} className="message">
                  <span>{row.text}</span>
                  <Badge tone={row.sent ? 'success' : 'info'}>{row.sent ? '发出' : '收到'}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Dialog
        open={details}
        onOpenChange={setDetails}
        title="统计详情"
        description="图表和列表使用示例数据。"
        footer={<Button onClick={() => setDetails(false)}>完成</Button>}
      >
        当前筛选匹配 {visible.length} 条消息。
      </Dialog>
    </PluginPageLayout>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('The plugin page is missing #root')
createRoot(root).render(
  <PanelUIProvider>
    <App />
  </PanelUIProvider>,
)

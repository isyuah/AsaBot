import { Card, PanelUIProvider, PluginPageLayout, TabPanel, Tabs } from '@asabot/panel-ui'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CatalogView } from '../src/contracts.ts'
import { Channels, type ModelSeed, Models } from './catalog.tsx'
import { Requests, Usage } from './observability.tsx'
import { Permissions } from './permissions.tsx'
import { Loading, RemoteError, useRemote } from './ui.tsx'
import '@asabot/panel-ui/styles.css'
import '@asabot/panel-ui/fonts.css'
import './style.css'

const tabs = [
  { value: 'channels', label: '渠道' },
  { value: 'models', label: '模型' },
  { value: 'permissions', label: '插件权限' },
  { value: 'requests', label: '请求记录' },
  { value: 'usage', label: '用量统计' },
] as const
type Tab = (typeof tabs)[number]['value']

function App() {
  const [tab, setTab] = useState<Tab>('channels')
  const [seed, setSeed] = useState<ModelSeed>()
  const [selected, setSelected] = useState<string>()
  const catalog = useRemote<CatalogView>('/catalog')
  const data = catalog.data

  return (
    <PanelUIProvider>
      <PluginPageLayout>
        {!data ? (
          <div className="ai-content">
            {catalog.error ? (
              <Card>
                <RemoteError error={catalog.error} retry={catalog.refresh} loading={catalog.loading} />
              </Card>
            ) : (
              <Loading />
            )}
          </div>
        ) : (
          <Tabs className="ai-tabs" tabs={[...tabs]} value={tab} onChange={setTab}>
            <TabPanel className="ai-content" value="channels">
              <Channels
                data={data}
                reload={catalog.refresh}
                onPickDiscovered={(item) => {
                  setSeed(item)
                  setTab('models')
                }}
              />
            </TabPanel>
            <TabPanel className="ai-content" value="models">
              <Models
                data={data}
                reload={catalog.refresh}
                seed={seed}
                clearSeed={() => setSeed(undefined)}
                showRequest={(id) => {
                  setSelected(id)
                  setTab('requests')
                }}
              />
            </TabPanel>
            <TabPanel className="ai-content" value="permissions">
              <Permissions data={data} reload={catalog.refresh} />
            </TabPanel>
            <TabPanel className="ai-content" value="requests">
              <Requests data={data} reload={catalog.refresh} selected={selected} onSelect={setSelected} />
            </TabPanel>
            <TabPanel className="ai-content" value="usage">
              <Usage data={data} />
            </TabPanel>
          </Tabs>
        )}
      </PluginPageLayout>
    </PanelUIProvider>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing AI plugin root')
createRoot(root).render(<App />)

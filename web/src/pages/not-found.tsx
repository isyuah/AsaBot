import { Button, Card, EmptyState } from '@asabot/panel-ui'
import { Compass } from 'lucide-react'
import { navigate } from '../lib/router.tsx'

export function NotFoundPage() {
  return (
    <Card className="mt-10">
      <EmptyState
        icon={<Compass />}
        title="页面不存在"
        description="这个地址没有对应的页面。"
        action={
          <Button variant="primary" onClick={() => navigate('/')}>
            回到概览
          </Button>
        }
      />
    </Card>
  )
}

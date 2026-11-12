import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, CheckCircle2, Plus, ShieldCheck, Trash2, User, Users } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button.tsx'
import { Dialog } from '../components/ui/dialog.tsx'
import { Field, Input } from '../components/ui/input.tsx'
import { Segmented } from '../components/ui/misc.tsx'
import { Card, CardHeader, EmptyState, PageHeader, Skeleton } from '../components/ui/primitives.tsx'
import { api } from '../lib/api.ts'
import { softSpring } from '../lib/motion.ts'
import { isValidId, usePlatforms } from '../lib/platform.ts'
import type { AccessEntry, AccessList, AccessSubject } from '../lib/types.ts'

const sameEntry = (a: AccessEntry, b: AccessEntry) =>
  a.list === b.list && a.subject === b.subject && a.key === b.key

export function AclPage() {
  const client = useQueryClient()
  const acl = useQuery({ queryKey: ['acl'], queryFn: api.acl })
  const [dialog, setDialog] = useState<AccessList | null>(null)

  const add = useMutation({
    mutationFn: api.addAcl,
    onSuccess: (_result, entry) => {
      client.setQueryData<AccessEntry[]>(['acl'], (list = []) => [
        ...list.filter((item) => !sameEntry(item, entry)),
        entry,
      ])
      setDialog(null)
      toast.success('已添加')
    },
  })
  const remove = useMutation({
    mutationFn: api.removeAcl,
    onSuccess: (_result, entry) => {
      client.setQueryData<AccessEntry[]>(['acl'], (list = []) =>
        list.filter((item) => !sameEntry(item, entry)),
      )
      toast('已移除', {
        description: entry.key,
        action: { label: '撤销', onClick: () => add.mutate(entry) },
      })
    },
  })

  const lists: { list: AccessList; title: string; description: string; icon: typeof Ban }[] = [
    { list: 'block', title: '屏蔽名单', description: '名单中的用户或群发来的事件一律忽略', icon: Ban },
    {
      list: 'allow',
      title: '白名单',
      description: '非空时，只有名单中的用户（或群）能使用机器人',
      icon: CheckCircle2,
    },
  ]

  return (
    <>
      <PageHeader
        title="访问控制"
        description="超管始终不受限制。用户和群两个维度分别生效：某一维度的白名单为空时，不限制这个维度。"
      />
      <div className="grid gap-3 lg:grid-cols-2">
        {lists.map(({ list, title, description, icon: Icon }) => {
          const entries = acl.data?.filter((entry) => entry.list === list) ?? []
          return (
            <Card key={list} className="flex flex-col">
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <Icon className={list === 'block' ? 'size-4 text-danger' : 'size-4 text-success'} />
                    {title}
                  </span>
                }
                description={description}
                action={
                  <Button size="sm" onClick={() => setDialog(list)}>
                    <Plus className="size-3.5" />
                    添加
                  </Button>
                }
              />
              <div className="flex-1 px-2 pb-2">
                {acl.isPending ? (
                  <div className="space-y-2 px-3 pb-2">
                    <Skeleton className="h-11" />
                    <Skeleton className="h-11" />
                  </div>
                ) : entries.length === 0 ? (
                  <EmptyState icon={<ShieldCheck />} title="名单为空" className="py-10" />
                ) : (
                  <ul>
                    <AnimatePresence initial={false}>
                      {entries.map((entry) => {
                        const [platform, ...rest] = entry.key.split(':')
                        return (
                          <motion.li
                            key={`${entry.subject}:${entry.key}`}
                            layout
                            initial={{ opacity: 0, x: -8 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 8, transition: { duration: 0.15 } }}
                            transition={softSpring}
                            className="group flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-2/70"
                          >
                            <span className="flex size-8 items-center justify-center rounded-lg bg-surface-2 text-fg-3">
                              {entry.subject === 'user' ? (
                                <User className="size-4" />
                              ) : (
                                <Users className="size-4" />
                              )}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="font-mono text-[13px] text-fg">{rest.join(':')}</div>
                              <div className="text-[11.5px] text-fg-3">
                                {entry.subject === 'user' ? '用户' : '群'} · {platform}
                              </div>
                            </div>
                            <Button
                              variant="danger-ghost"
                              size="icon-sm"
                              aria-label="移除"
                              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={() => remove.mutate(entry)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </motion.li>
                        )
                      })}
                    </AnimatePresence>
                  </ul>
                )}
              </div>
            </Card>
          )
        })}
      </div>
      <AddEntryDialog
        list={dialog}
        pending={add.isPending}
        onClose={() => setDialog(null)}
        onSubmit={(entry) => add.mutate(entry)}
      />
    </>
  )
}

function AddEntryDialog({
  list,
  pending,
  onClose,
  onSubmit,
}: {
  list: AccessList | null
  pending: boolean
  onClose: () => void
  onSubmit: (entry: AccessEntry) => void
}) {
  const [subject, setSubject] = useState<AccessSubject>('user')
  const [id, setId] = useState('')
  const platforms = usePlatforms()
  const [platform, setPlatform] = useState('')
  const effectivePlatform = platform || platforms[0] || ''
  const valid = isValidId(id) && effectivePlatform.trim().length > 0

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!list || !valid) return
    onSubmit({ list, subject, key: `${effectivePlatform.trim()}:${id.trim()}` })
    setId('')
  }

  return (
    <Dialog
      open={list !== null}
      onOpenChange={(open) => !open && onClose()}
      title={list === 'block' ? '添加到屏蔽名单' : '添加到白名单'}
      description={
        list === 'allow' ? '注意：白名单非空后，不在名单里的用户（或群）将无法使用机器人。' : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant={list === 'block' ? 'danger' : 'primary'}
            loading={pending}
            disabled={!valid}
            onClick={submit}
          >
            添加
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Segmented
          value={subject}
          onChange={setSubject}
          options={[
            { value: 'user', label: '用户' },
            { value: 'group', label: '群' },
          ]}
        />
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label={subject === 'user' ? '用户 ID' : '群 ID'} htmlFor="acl-id">
            <Input
              id="acl-id"
              autoFocus
              value={id}
              onChange={(event) => setId(event.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="平台" htmlFor="acl-platform">
            <Input
              id="acl-platform"
              value={effectivePlatform}
              placeholder="平台"
              onChange={(event) => setPlatform(event.target.value)}
              className="font-mono"
            />
          </Field>
        </div>
      </form>
    </Dialog>
  )
}

import { useId } from 'react'

import { useTranslation } from '../../app/stores/settings'
import type { Document } from '../../types'

/**
 * 문서 제목으로 범위를 고르는 드롭다운.
 *
 * 언어 버튼 옆에 둔다 — 둘은 같은 것('무엇을 보고 있는가')을 고르기 때문이다.
 * 따로 떨어뜨려 두면 한쪽만 바꾸고 다른 쪽이 어긋난 것을 눈에 띄지 않는다.
 *
 * 제목이 겹칠 수 있다. 그래서 값은 id 이고 눈에 보이는 것은 제목이다 — 같은 제목의
 * 다른 문서를 골랐는데 목록이 같아 보이면, 고른 것이 맞는지 알 방법이 없다.
 */
export function DocumentScopeSelect({
  value,
  documents,
  onChange,
}: {
  value: string
  documents: Document[]
  onChange: (documentId: string) => void
}) {
  const t = useTranslation()
  const labelId = useId()

  // 문서가 하나뿐이면 고를 것이 없다 — 전체와 같으므로 숨긴다
  if (documents.length < 2) return null

  return (
    <label htmlFor={labelId} className="mb-3 flex items-center gap-2 text-sm">
      <span className="text-ink-muted shrink-0 text-xs">{t('wordbook.documentLabel')}</span>
      <select
        id={labelId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="border-line focus:border-accent min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-sm outline-none"
      >
        <option value="">{t('wordbook.allDocuments')}</option>
        {documents.map((doc) => (
          <option key={doc.id} value={doc.id}>
            {doc.title}
          </option>
        ))}
      </select>
    </label>
  )
}
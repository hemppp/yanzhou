import { useChapterStore } from '@novel-plugins/data-core/stores';
import { useState } from 'react';
import { Download, FileText, Code, File, FileType, Package } from 'lucide-react';
import { exportBook } from '../services/data/exportService';
import { export砚舟Package, download砚舟Package } from '../services/misc/projectExportService';

export function ExportDialog() {
  const chapters = useChapterStore((s) => s.chapters);
  const [format, setFormat] = useState<'markdown' | 'html' | 'txt' | 'pdf' | 'docx' | 'epub'>('markdown');
  const [range, setRange] = useState<'all' | 'selected'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  /** 过滤批注块：开启 = 导出内容不含正文里的内嵌批注块（类型徽标 + 批注文字） */
  const [filterAnnotations, setFilterAnnotations] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    const exportChapters =
      range === 'all'
        ? chapters
        : chapters.filter((ch) => selectedIds.has(ch.id));

    try {
      exportBook({
        title: '我的小说',
        chapters: exportChapters.map((ch) => ({
          title: ch.title,
          content: ch.content,
        })),
        format,
        filterAnnotations,
      });
    } catch (e) {
      console.error('导出失败:', e);
    }

    setExporting(false);
  };

  const handleProjectExport = () => {
    const pkg = export砚舟Package();
    download砚舟Package(pkg);
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const formats = [
    { id: 'markdown' as const, icon: FileText, label: 'Markdown', ext: '.md' },
    { id: 'html' as const, icon: Code, label: '网页', ext: '.html' },
    { id: 'txt' as const, icon: File, label: '纯文本', ext: '.txt' },
    { id: 'pdf' as const, icon: FileType, label: 'PDF 文档', ext: '.pdf' },
    { id: 'docx' as const, icon: FileType, label: 'Word 文档', ext: '.doc' },
    { id: 'epub' as const, icon: FileType, label: '电子书', ext: '.epub' },
  ];

  return (
    <div className="mc-modal h-full overflow-y-auto p-4 space-y-4 mc-scrollbar">
      <h2 className="mc-title flex items-center gap-2">
        <Download size={20} />
        导出小说
      </h2>

      {/* 格式选择 */}
      <div>
        <label className="mc-title-sm mb-2 block">导出格式</label>
        <div className="grid grid-cols-3 gap-2">
          {formats.map((f) => (
            <button
              key={f.id}
              onClick={() => setFormat(f.id)}
              className={`mc-hotbar-btn flex items-center gap-2 px-3 py-2 text-sm ${
                format === f.id ? 'border-primary bg-primary/10' : ''
              }`}
            >
              <f.icon size={14} />
              {f.label}
              <span className="text-xs text-muted-foreground ml-auto">{f.ext}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 范围选择 */}
      <div>
        <label className="mc-title-sm mb-2 block">导出范围</label>
        <div className="flex gap-2 mb-2">
          <button
            onClick={() => setRange('all')}
            className={`mc-hotbar-btn px-3 py-1.5 text-sm ${
              range === 'all' ? 'border-primary bg-primary/10' : ''
            }`}
          >
            全部章节
          </button>
          <button
            onClick={() => setRange('selected')}
            className={`mc-hotbar-btn px-3 py-1.5 text-sm ${
              range === 'selected' ? 'border-primary bg-primary/10' : ''
            }`}
          >
            选定章节
          </button>
        </div>

        {range === 'selected' && (
          <div className="mc-card border p-2 max-h-48 overflow-y-auto space-y-1 mc-scrollbar">
            {chapters.map((ch) => (
              <label key={ch.id} className="mc-fs-item flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedIds.has(ch.id)}
                  onChange={() => toggleSelect(ch.id)}
                  className="mc-checkbox"
                />
                {ch.title}
                <span className="text-xs text-muted-foreground ml-auto">
                  {ch.wordCount} 字                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* 批注块过滤 */}
      <div>
        <label className="mc-fs-item flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={filterAnnotations}
            onChange={(e) => setFilterAnnotations(e.target.checked)}
            className="mc-checkbox"
          />
          过滤批注块
        </label>
        <p className="text-xs text-muted-foreground mt-1">
          {filterAnnotations ? '导出内容不含正文中的批注块' : '导出内容包含正文中的批注块'}
        </p>
      </div>

      {/* 导出按钮 */}
      <button
        onClick={handleExport}
        disabled={exporting || (range === 'selected' && selectedIds.size === 0)}
        className={`mc-btn mc-btn-primary w-full py-2 disabled:opacity-50 ${exporting ? 'animate-mc-xp' : ''}`}
      >
        {exporting ? '导出中...' : '导出'}
      </button>

      <p className="text-xs text-muted-foreground text-center">
        {chapters.length} 章节 · 共 {chapters.reduce((s, ch) => s + ch.wordCount, 0).toLocaleString()} 字      </p>

      {/* 项目打包导出 */}
      <div className="mc-divider border-t pt-3 mt-3">
        <button
          onClick={handleProjectExport}
          className="mc-btn mc-btn-primary w-full py-2.5 text-sm font-medium flex items-center justify-center gap-2"
        >
          <Package size={14} />
          导出完整项目 (.novelmuse)
        </button>
        <p className="text-xs text-muted-foreground text-center mt-1">
          包含所有章节、角色、伏笔、大纲、笔记等完整数据
        </p>
      </div>
    </div>
  );
}

#!/usr/bin/env node
/**
 * security_scan.mjs - 扫描源码中的敏感信息
 * 检测模式：密钥、Token、密码、私钥等
 */

import { readdir, stat, readFile } from 'fs/promises'
import { join, relative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '../')

// 敏感信息模式
const SENSITIVE_PATTERNS = [
  { pattern: /wbpk_[a-zA-Z0-9]{20,}/g, desc: 'WorkBuddy Publishable Key' },
  { pattern: /wbapp_[a-zA-Z0-9]{20,}/g, desc: 'WorkBuddy App ID' },
  { pattern: /tcb_[a-zA-Z0-9]{20,}/g, desc: 'TCB Token' },
  { pattern: /pk_[a-zA-Z0-9]{20,}/g, desc: 'Publishable Key' },
  { pattern: /sk_[a-zA-Z0-9]{20,}/g, desc: 'Secret Key' },
  { pattern: /api[_-]?key[s]?[=:]\s*["'][^"']+["']/gi, desc: 'API Key 配置' },
  { pattern: /password[=:]\s*["'][^"']+["']/gi, desc: '密码配置' },
  { pattern: /secret[=:]\s*["'][^"']+["']/gi, desc: '密钥配置' },
  { pattern: /private[_-]?key[_-]?id[=:]\s*["'][^"']+["']/gi, desc: '私钥ID' },
  { pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g, desc: '私钥文件' },
  { pattern: /token[=:]\s*["'][a-zA-Z0-9_\-]{20,}["']/gi, desc: 'Token 配置' },
]

// 排除的文件/目录
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'electron',
  'ios/ios',
  'windows/dist',
  '.workbuddy',
])

const EXCLUDE_FILES = new Set([
  '.env',
  '.env.local',
  '.tcbrc',
  '.cloudbaserc',
])

async function isDirectory(path) {
  try {
    const s = await stat(path)
    return s.isDirectory()
  } catch {
    return false
  }
}

async function scanFile(filePath) {
  const relPath = relative(ROOT, filePath)
  try {
    const content = await readFile(filePath, 'utf8')
    const findings = []

    for (const { pattern, desc } of SENSITIVE_PATTERNS) {
      let match
      while ((match = pattern.exec(content)) !== null) {
        findings.push({
          line: content.slice(0, match.index).split('\n').length,
          desc,
          match: match[0].slice(0, 50) + (match[0].length > 50 ? '...' : ''),
        })
      }
    }

    return findings.length > 0 ? { file: relPath, findings } : null
  } catch (err) {
    return null
  }
}

async function scanDirectory(dirPath) {
  const results = []
  const entries = await readdir(dirPath, { withFileTypes: true })

  for (const entry of entries) {
    const fullpath = join(dirPath, entry.name)

    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue
      const subResults = await scanDirectory(fullpath)
      results.push(...subResults)
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name)) continue
      const ext = entry.name.split('.').pop().toLowerCase()
      // 只扫描文本文件
      if (['js', 'mjs', 'ts', 'jsx', 'tsx', 'json', 'html', 'css', 'vue', 'py', 'sh', 'bat', 'cmd', 'md'].includes(ext)) {
        const result = await scanFile(fullpath)
        if (result) results.push(result)
      }
    }
  }

  return results
}

async function main() {
  console.log('🔍 开始扫描敏感信息...\n')

  const findings = await scanDirectory(ROOT)

  if (findings.length === 0) {
    console.log('✅ 未发现敏感信息\n')
    process.exit(0)
  }

  console.log(`⚠️  发现 ${findings.length} 个文件包含潜在敏感信息：\n`)

  for (const { file, findings: fs } of findings) {
    console.log(`📄 ${file}`)
    for (const f of fs) {
      console.log(`   第 ${f.line} 行: ${f.desc}`)
      console.log(`      ${f.match}`)
    }
    console.log()
  }

  console.log('\n建议：请移除或替换上述敏感信息，使用环境变量或配置文件管理密钥。\n')
  process.exit(1)
}

main().catch(err => {
  console.error('扫描失败:', err)
  process.exit(2)
})

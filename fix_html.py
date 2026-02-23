import re

with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. 無効コメント '< !-- ' → '<!-- ' に修正（スペース入り不正コメントを正規コメントに）
fixed = content.replace('< !-- ', '<!-- ')
fixed = fixed.replace('< !--\n', '<!--\n')

# 2. 壊れたoption値（改行で分割されたもの）を修正
# 例: '1:2,\n                                 500' → '1:2,500'
fixed = re.sub(r'(>1:\d+,)\s*\n\s+(\d+</option>)', r'\1\2', fixed)

count_before = content.count('< !-- ')
print(f'コメント修正: {count_before}箇所')

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(fixed)

print('修正完了')

#!/bin/bash
### fnclearup 安装/升级统计推送公共库
### 调用方式：source "$(dirname "${BASH_SOURCE[0]}")/lib/feishu_push.sh"
###
### 提供函数：
###   feishu_push_install <app_name> <app_version>           # 首次安装
###   feishu_push_upgrade <app_name> <old_version> <new_version>  # 升级

FEISHU_APP_ID="SANITIZED"
FEISHU_APP_SECRET="SANITIZED"
FEISHU_APP_TOKEN="JXxibJOYcaC7ZFsuKmecTwibnjf"
FEISHU_TABLE_ID="tbl1kmuwQu2CToeN"

# 获取设备稳定 UUID (同一台机器永远相同, 跨 install/upgrade/重启)
# 来源: /etc/machine-id (systemd 标准) → /proc/cpuinfo Serial → 持久化文件兜底
# 这样飞书多维表格可以用 UUID 排重算出"真实装机量" (而不是"安装事件数")
_feishu_get_device_uuid() {
    local raw=""

    # 1. 优先 /etc/machine-id (systemd 标准,任何用户可读)
    if [ -r /etc/machine-id ]; then
        raw=$(tr -d '[:space:]' < /etc/machine-id 2>/dev/null)
    fi

    # 2. 兜底 /proc/cpuinfo Serial (老系统/非 systemd,绝大多数 x86 CPU 都有)
    if [ -z "${raw}" ] || [ "${#raw}" -lt 16 ]; then
        raw=$(grep -m1 'Serial' /proc/cpuinfo 2>/dev/null | awk '{print $3}' | tr -d '[:space:]')
    fi

    # 3. 实在没有 → 持久化到 /var/cache (install 回调可能没 PKGVAR)
    if [ -z "${raw}" ] || [ "${#raw}" -lt 16 ]; then
        local uuid_file="/var/cache/.fnclearup_device_uuid"
        if [ -f "${uuid_file}" ]; then
            raw=$(cat "${uuid_file}" 2>/dev/null | tr -d '[:space:]')
        else
            raw=$(cat /proc/sys/kernel/random/uuid | tr -d '[:space:]')
            mkdir -p /var/cache 2>/dev/null && \
                printf "%s" "${raw}" > "${uuid_file}" 2>/dev/null && \
                chmod 644 "${uuid_file}" 2>/dev/null
        fi
    fi

    # 4. 格式化成 8-4-4-4-12 标准 UUID 格式 (用 machine-id 32 hex)
    #    如果 raw 不是 32 字符,补 0 或截断到 32
    raw=$(printf "%-32s" "${raw}" | tr ' ' '0')
    printf "%s-%s-%s-%s-%s" \
        "${raw:0:8}" "${raw:8:4}" "${raw:12:4}" "${raw:16:4}" "${raw:20:12}"
}

# 获取 IP 归属地（城市/省/国家）
_feishu_get_ip_location() {
    local city region country
    city=$(curl -s --connect-timeout 5 "https://ipinfo.io/city" 2>/dev/null || true)
    region=$(curl -s --connect-timeout 5 "https://ipinfo.io/region" 2>/dev/null || true)
    country=$(curl -s --connect-timeout 5 "https://ipinfo.io/country" 2>/dev/null || true)
    printf "%s %s %s" "${city}" "${region}" "${country}"
}

# 获取飞书 tenant_access_token
_feishu_get_token() {
    local resp token
    resp=$(curl -s -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
        -H "Content-Type: application/json" \
        -d "{\"app_id\":\"${FEISHU_APP_ID}\",\"app_secret\":\"${FEISHU_APP_SECRET}\"}" 2>/dev/null)
    token=$(printf "%s" "${resp}" | grep -o '"tenant_access_token":"[^"]*"' | cut -d'"' -f4)
    if [ -z "${token}" ]; then
        echo "[feishu] Failed to get token: ${resp}" >&2
        return 1
    fi
    printf "%s" "${token}"
}

# 写入飞书多维表格
_feishu_write_record() {
    local token="$1"; shift
    local record_id="$1"; shift
    local app_name="$1"; shift
    local app_ver="$1"; shift
    local old_ver="$1"; shift
    local event_time="$1"; shift
    local status="$1"; shift
    local ip_addr="$1"; shift

    curl -s -X POST "https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records" \
        -H "Authorization: Bearer ${token}" \
        -H "Content-Type: application/json" \
        -d "{
  \"fields\": {
    \"ID\": \"${record_id}\",
    \"应用名称\": \"${app_name}\",
    \"版本号\": \"${app_ver}\",
    \"旧版本号\": \"${old_ver}\",
    \"安装日期\": \"${event_time}\",
    \"安装状态\": \"${status}\",
    \"安装位置\": \"${ip_addr}\"
  }
}" > /dev/null 2>&1 || true
}

# 首次安装推送
feishu_push_install() {
    local app_name="$1"
    local app_version="$2"
    local event_time ip_addr record_id token
    event_time=$(date '+%Y年%-m月%-d日 %H:%M')
    ip_addr=$(_feishu_get_ip_location)
    record_id=$(_feishu_get_device_uuid)
    token=$(_feishu_get_token) || return 0
    _feishu_write_record "${token}" "${record_id}" "${app_name}" "${app_version}" "" "${event_time}" "首次安装成功" "${ip_addr}"
}

# 升级推送
feishu_push_upgrade() {
    local app_name="$1"
    local old_version="$2"
    local new_version="$3"
    local event_time ip_addr record_id token
    event_time=$(date '+%Y年%-m月%-d日 %H:%M')
    ip_addr=$(_feishu_get_ip_location)
    record_id=$(_feishu_get_device_uuid)
    token=$(_feishu_get_token) || return 0
    _feishu_write_record "${token}" "${record_id}" "${app_name}" "${new_version}" "${old_version}" "${event_time}" "升级成功" "${ip_addr}"
}

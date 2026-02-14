#!/bin/bash
# DistroIA Sovereignty Pre-flight Check 🦍🛡️💎
# Ensures the Masterpiece state is intact.

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== Masterpiece Integrity Audit ===${NC}"

# 1. Check Bar Layout (3-Capsule Separation)
if grep -q "ResourcePill" ui/ags-v3/widget/Bar.tsx && grep -q "TrayPill" ui/ags-v3/widget/Bar.tsx && grep -q "TimePill" ui/ags-v3/widget/Bar.tsx; then
    echo -e "  [${GREEN}OK${NC}] Bar: 3-Capsule Layout (Phase F)"
else
    echo -e "  [${RED}FAIL${NC}] Bar: 3-Capsule logic missing!"
fi

# 2. Check Bar Stability Fix (GtkOverlay)
if grep -q "overlay.set_child(canvas)" ui/ags-v3/widget/Bar.tsx; then
    echo -e "  [${GREEN}OK${NC}] Bar: GtkOverlay stability fix active"
else
    echo -e "  [${RED}FAIL${NC}] Bar: Crash-prone GtkOverlay constructor detected!"
fi

# 3. Check Control Center Separation (32px)
if grep -q "margin_top: 32" ui/ags-v3/widget/ControlCenter.tsx; then
    echo -e "  [${GREEN}OK${NC}] CC: 32px Section Separation (Phase G)"
else
    echo -e "  [${RED}FAIL${NC}] CC: Missing 32px internal gap!"
fi

# 4. Check Schematic Engine
if [ -f "ui/ags-v3/widget/Schematic.tsx" ]; then
    echo -e "  [${GREEN}OK${NC}] Schematic Engine: Present"
else
    echo -e "  [${RED}FAIL${NC}] Schematic Engine: Missing!"
fi

# 5. Check Build Integrity
echo -e "${BLUE}  Running build check...${NC}"
cd ui/ags-v3 && npm run build
if [ $? -eq 0 ]; then
    echo -e "  [${GREEN}OK${NC}] Build: Successful"
else
    echo -e "  [${RED}FAIL${NC}] Build: FAILED!"
fi

echo -e "${BLUE}==================================${NC}"

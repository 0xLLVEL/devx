# DevBox UI Design System & Frontend Guidelines

> **Document purpose:** This file is the canonical UI/UX guideline for
> the DevBox desktop application.
>
> **Target stack:** Rust backend/runtime engine + React frontend.
>
> **Product type:** Multipurpose local development environment and
> runtime manager inspired by products such as ServBay, Laravel Herd,
> EnvKit, Lerd, and modern developer desktop applications.
>
> **Primary design direction:** Premium developer tool, dark-first,
> technically sophisticated, calm, fast, information-dense without
> feeling cluttered.

------------------------------------------------------------------------

## 1. Product Design Vision

DevBox should feel like a **professional developer cockpit**, not an
administration panel.

The interface must communicate:

-   Fast
-   Technical
-   Reliable
-   Local-first
-   Powerful
-   Modular
-   Modern
-   Premium
-   Calm under heavy information density

The product should allow a developer to understand the state of their
entire local environment within a few seconds.

### Core product promise

> **Run. Manage. Build.**

A developer should be able to:

1.  Install and switch runtimes.
2.  Start/stop services.
3.  Create and manage local sites.
4.  Manage databases.
5.  Manage environment variables.
6.  Open a project.
7.  Run commands.
8.  Inspect logs.
9.  Open an integrated terminal.
10. Change configuration without leaving the application.

### Design principle

**Complexity should exist underneath the interface, not inside it.**

The UI should expose advanced capabilities progressively.

------------------------------------------------------------------------

# 2. Platform Context

DevBox consists of two major layers:

``` text
┌───────────────────────────────────────────────┐
│                  React UI                     │
│ Navigation / Views / Components / Terminal    │
└──────────────────────┬────────────────────────┘
                       │ IPC / Commands
┌──────────────────────▼────────────────────────┐
│                  Rust Core                    │
│ Runtime / Process / Files / Network / Config  │
└───────────────────────────────────────────────┘
```

The frontend is responsible for:

-   Presentation
-   Navigation
-   User interaction
-   Local UI state
-   Forms
-   Dialogs
-   Command palette
-   Terminal presentation
-   Loading/error/success states
-   Charts and visualizations

Rust is responsible for:

-   Runtime discovery
-   Runtime installation
-   Process lifecycle
-   Service management
-   Port management
-   Hosts/domain configuration
-   Environment management
-   File operations
-   Logs
-   System information
-   Persistent application state
-   Privileged operations where required

### Important frontend rule

Never make the UI depend on optimistic assumptions about Rust state.

Every process/service/runtime action should have explicit states:

``` text
idle
starting
running
stopping
stopped
restarting
error
unknown
```

The UI should never display "Running" simply because a user clicked a
toggle.

------------------------------------------------------------------------

# 3. Overall Information Architecture

Primary sidebar:

``` text
HOME
RUNTIMES
SERVERS
SITES
DATABASES
CONTAINERS
ENVIRONMENT
TOOLS
EXTENSIONS

-------------------------

PROJECTS
  project-a
  project-b
  project-c

-------------------------

SYSTEM STATUS
```

### Primary routes

``` text
/
  Dashboard

/runtimes
  Runtime Manager

/runtimes/:runtime
  Runtime Detail

/servers
  Server Manager

/servers/:server
  Server Detail

/sites
  Sites Manager

/sites/:site
  Site Detail

/databases
  Database Manager

/databases/:database
  Database Detail

/containers
  Container Manager

/containers/:container
  Container Detail

/environment
  Environment Manager

/environment/:project
  Project Environment

/tools
  Developer Tools

/extensions
  Extensions

/projects
  Project Manager

/projects/:project
  Project Detail

/terminal
  Terminal

/settings
  Settings
```

The user should be able to reach all primary features from the sidebar,
command palette, and global search.

------------------------------------------------------------------------

# 4. Global Application Shell

The application shell consists of:

``` text
┌───────────────────────────────────────────────────────────────┐
│ Topbar                                                        │
├──────────────┬────────────────────────────────────────────────┤
│              │                                                │
│ Sidebar      │ Main Content                                   │
│              │                                                │
│              │                                                │
│              │                                                │
│              │                                                │
├──────────────┴────────────────────────────────────────────────┤
│ Optional contextual bottom panel / terminal                   │
└───────────────────────────────────────────────────────────────┘
```

### Desktop baseline

Target:

-   Minimum supported width: 1100px
-   Preferred width: 1440px+
-   Ideal design canvas: 1536 × 960
-   Minimum height: 700px

The app is desktop-first.

Do not design the UI like a responsive website.

Instead, support:

-   Window resizing
-   Sidebar collapse
-   Panel resizing
-   Dense mode
-   Full-screen terminal
-   Full-screen detail views

------------------------------------------------------------------------

# 5. Sidebar

## Dimensions

Expanded:

``` text
width: 232px
```

Collapsed:

``` text
width: 68px
```

Transition:

``` text
220ms
cubic-bezier(0.22, 1, 0.36, 1)
```

Sidebar should remain visually stable while content changes.

## Sidebar structure

``` text
[Logo] DevBox                 v2.1.0

[⌂] Home
[◈] Runtimes                 6
[▤] Servers                  4
[◎] Sites                    5
[▣] Databases                4
[◇] Containers               2
[⌘] Environment              3
[⚒] Tools                    8
[◇] Extensions               5

────────────────────────────

PROJECTS                         [+]

[icon] laravel-app          ●
[icon] nextjs-portfolio     ●
[icon] iot-traffic          ●
[icon] vue-dashboard        ●
[icon] file-uploader        ●

────────────────────────────

● System Ready
  All services are running
```

### Sidebar behavior

Active item:

-   Slightly elevated background
-   Thin left accent line
-   Accent icon
-   High-contrast text

Inactive:

-   Muted text
-   Transparent background

Hover:

-   Background opacity increases
-   Icon becomes brighter

Do not use excessive gradients on every item.

------------------------------------------------------------------------

# 6. Topbar

Height:

``` text
64px
```

Structure:

``` text
[Logo / page context]

[Global Search................................ Ctrl+K]

[Notifications] [Settings] [Theme] [Avatar]
```

### Search

Global search should support:

-   Projects
-   Runtimes
-   Servers
-   Sites
-   Databases
-   Containers
-   Tools
-   Commands
-   Settings

Placeholder:

> Search anything...

Keyboard:

``` text
Ctrl + K
```

On Windows/Linux use `Ctrl`.

If a macOS build is eventually supported, display `⌘`.

------------------------------------------------------------------------

# 7. Visual Language

## Design keywords

Use these words as the visual north star:

-   graphite glass
-   neutral graphite
-   coral accent
-   cyan highlights
-   subtle borders
-   controlled gradients
-   soft shadows
-   technical typography
-   compact controls
-   high information density
-   restrained animation

Avoid:

-   excessive neon
-   rainbow gradients
-   huge rounded cards
-   cartoon illustrations
-   excessive blur
-   giant typography
-   excessive empty space
-   overly rounded buttons
-   generic SaaS dashboard appearance

------------------------------------------------------------------------

# 8. Color System

Use semantic tokens instead of hard-coded colors.

## Dark theme

### Background

``` text
--bg-app:        #0E0E0F
--bg-sidebar:    #0F0F10
--bg-topbar:     #111112
--bg-surface:    #141415
--bg-surface-2:  #1A1A1B
--bg-elevated:   #1F1F20
--bg-hover:      #242425
```

### Borders

``` text
--border-subtle: #29292A
--border-default:#373738
--border-strong: #49494A
```

Borders should normally be 1px.

### Text

``` text
--text-primary:   #F7F7F8
--text-secondary: #B2B2B3
--text-muted:     #7C7C7D
--text-disabled:  #515152
```

### Accent

Primary:

``` text
--accent:         #FF6B5A
--accent-hover:   #FF8A7A
--accent-soft:    rgba(255,107,90,.14)
```

Secondary:

``` text
--cyan:           #39C6FF
--cyan-soft:      rgba(57,198,255,.12)
```

### Status

``` text
--success:        #32D583
--success-soft:   rgba(50,213,131,.12)

--warning:        #F5B942
--warning-soft:   rgba(245,185,66,.12)

--danger:         #FF5D73
--danger-soft:    rgba(255,93,115,.12)

--info:           #55A6FF
--info-soft:      rgba(85,166,255,.12)
```

Do not use status colors as decorative colors.

Green means healthy/running/success.

Red means failure/destructive action.

Yellow means warning/attention.

Blue/cyan means information.

Coral is the primary product accent.

------------------------------------------------------------------------

# 9. Light Theme

The application must support light mode.

Use a soft developer-oriented light theme rather than pure white.

``` text
--bg-app:        #F4F6FA
--bg-sidebar:    #F8F9FC
--bg-topbar:     #FFFFFF
--bg-surface:    #FFFFFF
--bg-surface-2:  #F8FAFD
--bg-elevated:   #FFFFFF

--border-subtle: #E7EAF0
--border-default:#D9DEE8
--border-strong: #C5CBD7

--text-primary:   #172033
--text-secondary: #566176
--text-muted:     #7B879B
--text-disabled:  #AAB2C1

--accent:         #C2410C
--accent-hover:   #A6350A
```

Light mode must preserve the same hierarchy and component structure as
dark mode.

Do not create a separate design language.

------------------------------------------------------------------------

# 10. Typography

Primary font:

``` text
Inter
```

Fallback:

``` text
ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
```

Monospace:

``` text
JetBrains Mono
```

Fallback:

``` text
ui-monospace, SFMono-Regular, Consolas, monospace
```

## Type scale

``` text
Display:       32px / 38px / 700
H1:            24px / 30px / 700
H2:            18px / 24px / 650
H3:            15px / 20px / 650
Nav:           15px / 20px / 400 (500 when active)
Body:          14px / 20px / 400
Body Medium:   14px / 20px / 500
Small:         12px / 17px / 400
Caption:       11px / 15px / 500
Code:          12px / 18px / 400
```

Nav is the sidebar label step: the H3 size at label weight. Navigation reads
one step above body without competing with page headings, and the step lives
in the token layer rather than as a loose font size.

Do not use more than 4 font weights in a single screen.

Recommended:

``` text
400 Regular
500 Medium
600 Semibold
700 Bold
```

------------------------------------------------------------------------

# 11. Spacing System

Use a 4px base grid.

``` text
4
8
12
16
20
24
32
40
48
64
```

Recommended usage:

``` text
4px   icon/text micro spacing
8px   compact controls
12px  card internals
16px  standard padding
20px  section spacing
24px  major cards
32px  page sections
48px  large page separation
```

Do not randomly use values such as 13px, 17px, 23px unless required by a
specific control.

------------------------------------------------------------------------

# 12. Border Radius

Use moderate rounding.

``` text
radius-xs:  4px
radius-sm:  6px
radius-md:  8px
radius-lg:  12px
radius-xl:  16px
radius-2xl: 20px
```

Guidelines:

-   Inputs: 8px
-   Buttons: 8px
-   Cards: 12px
-   Dialogs: 16px
-   Command palette: 14px
-   Pills/badges: 999px

Avoid making everything pill-shaped.

------------------------------------------------------------------------

# 13. Shadows

Shadows are the only depth effect. Use elevation to separate real surfaces,
never to decorate.

Dark theme shadows:

``` text
shadow-sm:
0 2px 8px rgba(0,0,0,.18)

shadow-md:
0 8px 30px rgba(0,0,0,.24)

shadow-lg:
0 18px 60px rgba(0,0,0,.35)
```

Accent glow is not part of the product. No component carries it, and no
element reserves it.

------------------------------------------------------------------------

# 14. Glass / Surface Treatment

Cards should use:

``` text
background:
rgba(20,20,21,.82)

border:
1px solid rgba(255,255,255,.055)

backdrop-filter:
blur(14px)
```

However, avoid applying backdrop blur to every element.

Use real surfaces for most cards.

Glass is an accent layer, not the entire UI.

------------------------------------------------------------------------

# 15. Ambient Background

The dashboard background may contain an animated ambient effect.

Composition:

``` text
base:
dark graphite

very subtle particle field
```

There are no background gradients and no background glow; the ambient layer
is the particle field alone.

Particles should:

-   be sparse
-   move extremely slowly
-   have low opacity
-   never interfere with readability

Animation speed:

``` text
8–20 seconds
```

Avoid:

-   rapidly moving stars
-   excessive particle density
-   distracting lines
-   constant flashing

### Reduced motion

When:

``` text
prefers-reduced-motion: reduce
```

Disable:

-   particles
-   background movement
-   large transitions

------------------------------------------------------------------------

# 16. Dashboard

Route:

``` text
/
```

The dashboard is the most important screen.

## Layout

Recommended 12-column conceptual grid:

``` text
┌──────────────────────────────────────────────┐
│ Greeting / Status                            │
├────────┬────────┬────────┬────────┐
│Runtime │Server  │Sites   │Database│
├────────┴────────┴────────┴────────┤
│ Runtime Manager │ Server Manager  │
├──────────────────┼─────────────────┤
│ Sites            │ System Resource │
├──────────────────┼─────────────────┤
│ Databases        │ Environment     │
├──────────────────┴─────────────────┤
│ Containers / Tools                   │
├─────────────────────────────────────┤
│ Terminal                             │
└─────────────────────────────────────┘
```

Right rail may be used on wide displays:

``` text
Quick Actions
Recent Projects
Recent Activity
System Info
```

At 1100--1300px width, collapse the right rail into stacked sections.

------------------------------------------------------------------------

# 17. Dashboard Header

Example:

> Good evening, Developer

Subtitle:

> Your all-in-one runtime manager and developer environment.

Right side:

``` text
● All Systems Operational
```

Status card should summarize:

-   Running services
-   Failed services
-   Runtime issues
-   Port conflicts

Example:

``` text
● All Systems Operational
6 runtimes · 4 servers · 5 sites
```

------------------------------------------------------------------------

# 18. Summary Cards

Four primary cards:

``` text
Runtimes
6 active

Servers
4 running

Sites
5 active

Databases
4 running
```

Each card contains:

-   icon
-   label
-   value
-   status
-   optional trend
-   click interaction

Hover:

-   border accent
-   subtle lift 1px
-   accent icon colour

------------------------------------------------------------------------

# 19. Runtime Manager

Route:

``` text
/runtimes
```

## Header

``` text
Runtime Manager
Manage language runtimes installed on your machine.

[Search] [Filter] [Install Runtime]
```

## Runtime list

Columns:

``` text
Runtime
Version
Status
Path
Default
Actions
```

Example:

``` text
PHP
8.3.12
● Running
C:\DevBox\runtimes\php\8.3.12
✓ Default
[...]

Node.js
22.14.0
● Running
...
```

## Runtime detail

Show:

-   Runtime name
-   Version
-   architecture
-   executable path
-   installation source
-   environment variables
-   linked projects
-   process status
-   default status

Actions:

``` text
Start
Stop
Restart
Set as Default
Open Folder
Terminal
Uninstall
```

Destructive actions must require confirmation.

------------------------------------------------------------------------

# 20. Install Runtime Dialog

Dialog title:

> Install Runtime

Structure:

``` text
Runtime
[ PHP ▼ ]

Version
[ 8.3.12 ▼ ]

Architecture
[ x64 ▼ ]

Set as default
[ toggle ]

Add to PATH
[ toggle ]

Projects
[ Link later ]

                Cancel   Install
```

Installation progress:

``` text
Downloading...
██████████████░░░░ 72%

Verifying package...
```

Never freeze the UI.

Rust should emit progress events.

------------------------------------------------------------------------

# 21. Server Manager

Route:

``` text
/servers
```

Supported examples:

-   Nginx
-   Apache
-   Caddy
-   PHP-FPM
-   custom local services

Each server card:

``` text
Nginx
1.27.1

● Running

Port
80

Config
C:\DevBox\config\nginx

[Restart] [...]
```

Detailed server page:

Tabs:

``` text
Overview
Configuration
Logs
Sites
Ports
Environment
```

------------------------------------------------------------------------

# 22. Server Logs

Log viewer requirements:

-   monospace
-   line numbers optional
-   timestamp
-   severity
-   search
-   clear
-   pause
-   auto-scroll
-   copy
-   save/export

Severity:

``` text
INFO
WARN
ERROR
DEBUG
TRACE
```

Use colors sparingly.

Example:

``` text
21:44:01 INFO  Server started
21:44:02 INFO  Listening on 127.0.0.1:8080
21:44:05 WARN  Port 3306 already in use
21:44:07 ERROR Failed to start worker
```

------------------------------------------------------------------------

# 23. Sites Manager

Route:

``` text
/sites
```

Primary purpose:

Manage local domains and map them to projects/services.

Example:

``` text
laravel.test
https://laravel.test
PHP 8.3
Nginx
● Active

nextjs.local
http://nextjs.local
Node 22
Caddy
● Active
```

Actions:

``` text
Open
Open in Browser
Open Folder
Edit
Restart
Disable
Delete
```

------------------------------------------------------------------------

# 24. Create Site Dialog

Fields:

``` text
Project
[ Select project ]

Domain
[ my-project.test ]

Server
[ Nginx ]

Runtime
[ PHP 8.3 ]

HTTPS
[ toggle ]

Certificate
[ Auto ]

Port
[ Auto ]
```

Advanced section:

``` text
Custom root
Index file
PHP-FPM pool
Environment
Headers
Proxy target
```

Advanced options should be collapsed by default.

------------------------------------------------------------------------

# 25. Database Manager

Route:

``` text
/databases
```

Support visual management for:

-   MySQL
-   MariaDB
-   PostgreSQL
-   Redis
-   SQLite

Database cards:

``` text
MySQL
8.4.3

● Running

Host
127.0.0.1

Port
3306

Databases
12

[Connect] [...]
```

Actions:

``` text
Start
Stop
Restart
Open Client
Open Data
Create Database
Import
Export
Credentials
Logs
```

------------------------------------------------------------------------

# 26. Database Detail

Tabs:

``` text
Overview
Databases
Users
Connections
Logs
Configuration
```

For SQL databases, provide:

-   connection information
-   database list
-   user list
-   connection count
-   memory usage
-   version
-   port
-   config path

Never show passwords by default.

Password fields should have:

``` text
[••••••••••] [Show]
```

------------------------------------------------------------------------

# 27. Containers

Route:

``` text
/containers
```

The UI should support Docker/Podman-style workflows without becoming a
complete container orchestration dashboard.

List:

``` text
Container
Image
Status
Ports
CPU
Memory
Actions
```

Example:

``` text
mysql-dev
mysql:8.4
● Running
3306 → 3306
2.1%
384 MB
```

Container detail:

``` text
Overview
Logs
Terminal
Environment
Volumes
Network
Inspect
```

------------------------------------------------------------------------

# 28. Environment Manager

Route:

``` text
/environment
```

This is one of the key differentiators of DevBox.

Show environment variables at multiple scopes:

``` text
Global
Runtime
Server
Project
Site
```

Visual hierarchy:

``` text
GLOBAL
  PATH
  DEVBOX_HOME

PROJECT
  APP_ENV
  APP_DEBUG
  DB_HOST
  DB_PORT

SITE
  DOMAIN
  HTTPS
```

Variables should support:

-   Add
-   Edit
-   Duplicate
-   Delete
-   Search
-   Reveal secret
-   Copy
-   Import `.env`
-   Export `.env`

Sensitive values:

-   hidden by default
-   never put into logs
-   never display in notifications

------------------------------------------------------------------------

# 29. Project Manager

Route:

``` text
/projects
```

Projects are first-class entities.

Card:

``` text
Laravel App

Laravel
PHP 8.3
Node 22

C:\Users\Developer\Dev\laravel-app

● Active

[Open] [Terminal] [...]
```

Project detail should show:

``` text
Project header
├── Status
├── Runtime
├── Services
├── Site
└── Quick actions

Overview
Runtime
Services
Environment
Scripts
Terminal
Files
Activity
```

------------------------------------------------------------------------

# 30. Create Project Flow

Primary CTA:

``` text
New Project
```

Wizard:

### Step 1 --- Template

``` text
Laravel
Next.js
React
Vue
Vite
Node
Python
Empty
Custom
```

### Step 2 --- Location

``` text
Project name
Project path
```

### Step 3 --- Runtime

``` text
PHP 8.3
Node 22
Python 3.13
```

### Step 4 --- Services

``` text
MySQL
PostgreSQL
Redis
Nginx
```

### Step 5 --- Site

``` text
laravel.test
HTTPS enabled
```

### Step 6 --- Create

Show a live operation list:

``` text
✓ Creating project
✓ Installing dependencies
✓ Configuring runtime
✓ Creating site
✓ Starting services
✓ Project ready
```

------------------------------------------------------------------------

# 31. Terminal

The terminal is a first-class application feature.

Route:

``` text
/terminal
```

It may also appear as a bottom drawer.

## Bottom terminal

Default height:

``` text
280px
```

Resizable:

``` text
180px → 70vh
```

Full-screen option.

Tabs:

``` text
Terminal (laravel-app)   +
```

Toolbar:

``` text
[Shell ▼] [Project ▼] [Clear] [Split] [Maximize]
```

Terminal font:

``` text
JetBrains Mono
12–13px
```

Background should be nearly black but not pure black.

------------------------------------------------------------------------

# 32. Terminal Interaction

Support:

-   Ctrl+C
-   Ctrl+L
-   Ctrl+Shift+C
-   Ctrl+Shift+V
-   command history
-   tabs
-   split panes
-   resize
-   shell selection
-   working directory
-   environment selection

Potential shells:

``` text
PowerShell
cmd
Git Bash
WSL
Bash
zsh
```

Do not emulate shell behavior in React.

Rust owns the PTY/process.

React renders terminal output.

------------------------------------------------------------------------

# 33. Command Palette

Keyboard:

``` text
Ctrl + K
```

Overlay:

``` text
┌───────────────────────────────────────────┐
│ ⌕  Type a command or search...      Ctrl K│
├───────────────────────────────────────────┤
│ Recent                                    │
│   Open Project                       Alt P │
│   Start All Services                 Alt S │
│   Open Terminal                      Alt T │
│                                           │
│ Runtimes                                  │
│   PHP 8.3                           Alt R  │
│                                           │
│ Navigation                                │
│   Settings                          Alt ,  │
└───────────────────────────────────────────┘
```

Search should be fuzzy.

Categories:

``` text
Recent
Projects
Runtimes
Services
Sites
Databases
Commands
Navigation
Settings
```

Keyboard:

``` text
↑ ↓     Navigate
Enter   Execute
Esc     Close
```

The palette should feel extremely fast.

Target response:

``` text
< 50ms
```

for local UI filtering.

------------------------------------------------------------------------

# 34. Modal System

All dialogs should use the same primitive.

Structure:

``` text
┌──────────────────────────────────┐
│ Title                        ×   │
│ Description                      │
├──────────────────────────────────┤
│                                  │
│ Content                          │
│                                  │
├──────────────────────────────────┤
│              Cancel    Confirm   │
└──────────────────────────────────┘
```

Recommended width:

``` text
sm:  400px
md:  520px
lg:  680px
xl:  860px
```

Modal overlay:

``` text
rgba(0,0,0,.60)
backdrop-filter: blur(6px)
```

Do not use huge modal shadows.

------------------------------------------------------------------------

# 35. Confirmation Dialogs

Destructive:

``` text
Delete project?

This will remove the project configuration from DevBox.
The files on disk will not be deleted unless you explicitly select
"Delete project files".

[Cancel] [Delete]
```

Dangerous actions require explicit wording.

Never use:

> Are you sure?

by itself.

Tell the user what will happen.

------------------------------------------------------------------------

# 36. Toast Notifications

Position:

``` text
bottom-right
```

Width:

``` text
320–420px
```

Types:

``` text
Success
Info
Warning
Error
```

Example:

``` text
✓ Runtime installed

PHP 8.3.12 was installed successfully.

                 View
```

Duration:

``` text
success: 4s
info:    5s
warning: 6s
error:   persistent or 8s
```

Errors should provide:

``` text
[View Details]
```

when useful.

------------------------------------------------------------------------

# 37. Loading States

Avoid generic spinning loaders whenever possible.

Prefer skeletons.

Example:

``` text
Runtime Manager

██████████████
████████████████████

████████
████████████████
```

For actions:

``` text
Installing...
Starting...
Stopping...
Connecting...
```

Buttons should become temporarily disabled while an operation is
running.

------------------------------------------------------------------------

# 38. Empty States

Empty states should explain what the user can do.

Bad:

> No data.

Good:

> No runtimes installed yet. Install your first runtime to start
> building local projects.

CTA:

``` text
Install Runtime
```

Every empty state should have:

-   icon
-   short title
-   useful explanation
-   primary action

------------------------------------------------------------------------

# 39. Error States

Errors should be actionable.

Example:

``` text
Unable to start Nginx

Port 80 is already being used by another process.

Possible solutions:
• Stop the process using port 80
• Change the Nginx port
• View the process details

[View Port Usage] [Change Port]
```

Avoid technical stack traces in primary UI.

Put technical details behind:

``` text
Show diagnostic details
```

------------------------------------------------------------------------

# 40. System Resource Panel

Dashboard system resource card:

``` text
CPU
12%

RAM
34%

Disk
42%
96 GB / 256 GB
```

Use compact circular gauges or subtle line charts.

Do not over-animate graphs.

Refresh interval:

``` text
1–2 seconds
```

The Rust backend should provide normalized resource metrics.

------------------------------------------------------------------------

# 41. Recent Projects

Display 5--8 projects.

Each item:

``` text
[icon] laravel-app
      ~/Dev/laravel-app
      ● Active
      2h ago
```

Hover actions:

``` text
Open
Terminal
Open Folder
```

Avoid giant project cards.

------------------------------------------------------------------------

# 42. Recent Activity

Timeline:

``` text
● Started Nginx                         2 min ago
● Project opened: laravel-app           4 min ago
● Database connected: MySQL             7 min ago
● Installed package: Laravel Sanctum   12 min ago
```

Activity should be informative but not noisy.

------------------------------------------------------------------------

# 43. Tools Page

Developer tools should be grouped.

Categories:

``` text
Package Managers
  Composer
  npm
  pnpm
  yarn
  Bun
  pip

Languages
  PHP
  Node.js
  Python
  Go
  Java
  Ruby

Development
  Git
  Deno
  Docker
  VS Code
  Postman

Utilities
  Hosts
  Certificates
  SSH
  Port Inspector
```

Each tool:

``` text
Tool
Version
Status
Path
Update
Open
```

------------------------------------------------------------------------

# 44. Extensions

Extensions are optional integrations.

Extension cards:

``` text
Laravel Toolkit

Adds Laravel-specific project actions.

Installed

[Configure] [...]
```

Statuses:

``` text
Installed
Available
Update Available
Disabled
Error
```

Do not make extensions visually dominate the main application.

------------------------------------------------------------------------

# 45. Settings

Settings layout:

``` text
General
Appearance
Runtimes
Servers
Terminal
Projects
Environment
Network
Notifications
Updates
Privacy
Advanced
```

Settings should use a two-column layout:

``` text
┌──────────────┬───────────────────────────────┐
│ Settings     │ General                       │
│              │                               │
│ General      │ Start DevBox on system boot   │
│ Appearance   │ [ ON ]                        │
│ Terminal     │                               │
│ Projects     │ Minimize to tray              │
│ Network      │ [ ON ]                        │
│ ...          │                               │
└──────────────┴───────────────────────────────┘
```

------------------------------------------------------------------------

# 46. Appearance Settings

Controls:

``` text
Theme
[ Dark ] [ Light ] [ System ]

Accent
[ Purple ] [ Blue ] [ Cyan ]

Density
[ Comfortable ] [ Compact ]

Animations
[ Full ] [ Reduced ]

Background effects
[ On / Off ]
```

Theme switching should be instantaneous or use a short fade.

------------------------------------------------------------------------

# 47. Context Menus

Context menus should be compact.

Example project:

``` text
Open
Open in Browser
Open Folder
Open Terminal
Restart Services
Set as Active
Rename
Remove
```

Destructive items at bottom with danger styling.

------------------------------------------------------------------------

# 48. Buttons

## Primary

Used for the most important action.

``` text
background: accent
color: white
```

Examples:

``` text
Create Project
Install Runtime
Start Service
```

## Secondary

``` text
background: surface-2
border: default
```

## Ghost

Transparent.

Used for:

-   toolbar actions
-   icon buttons
-   low-priority actions

## Danger

Only destructive actions.

Never use danger red for ordinary errors or warnings.

------------------------------------------------------------------------

# 49. Iconography

Use one consistent icon system.

Recommended:

``` text
Lucide
```

Rules:

-   default stroke width: 1.8--2
-   16px for compact controls
-   18px standard
-   20px primary navigation
-   24px empty-state icons

Do not mix multiple icon styles.

Runtime logos may use official brand marks where licensing permits.

------------------------------------------------------------------------

# 50. Runtime Icons

Preferred visual hierarchy:

``` text
PHP
Node.js
Python
Go
Java
Ruby
Rust
Deno
Bun
```

Runtime logo should be secondary to the runtime name.

Do not let brand colors overpower the application color system.

------------------------------------------------------------------------

# 51. Micro-interactions

Micro-interactions are important but must be restrained.

## Button hover

``` text
120ms
```

Change:

-   background
-   border
-   slight brightness

## Card hover

``` text
160ms
transform: translateY(-1px)
```

No large movement.

## Toggle

``` text
180–220ms
```

Use a smooth thumb movement.

## Sidebar

``` text
220ms
```

## Modal

Open:

``` text
opacity 0 → 1
scale .98 → 1
```

Duration:

``` text
160ms
```

## Toast

``` text
translateY(8px) → 0
opacity 0 → 1
```

------------------------------------------------------------------------

# 52. Motion Principles

Motion should communicate:

-   hierarchy
-   state
-   feedback
-   continuity

Never animate simply because an element can animate.

Preferred easing:

``` text
cubic-bezier(0.22, 1, 0.36, 1)
```

For exits:

``` text
cubic-bezier(0.4, 0, 1, 1)
```

Keep most UI transitions under:

``` text
250ms
```

------------------------------------------------------------------------

# 53. Running State Animation

A running service can have a tiny animated indicator.

Example:

``` text
● Running
```

The dot may have a very subtle pulse.

A running service is a dot and a label, never an aura — the product uses no
glow in any state.

Error state should be static or minimally pulsing.

------------------------------------------------------------------------

# 54. Command Feedback

Every asynchronous operation must communicate state.

Example:

``` text
Start Nginx
     ↓
Starting...
     ↓
● Running
```

If failure:

``` text
Starting...
     ↓
× Failed
     ↓
View Details
```

Never silently fail.

------------------------------------------------------------------------

# 55. Accessibility

Minimum requirements:

-   keyboard navigation
-   visible focus
-   sufficient contrast
-   semantic buttons
-   labels for icon-only controls
-   tooltip for unfamiliar icons
-   `aria-label` where needed
-   reduced-motion support

Focus ring:

``` text
2px solid accent
outline-offset: 2px
```

Never remove focus indication.

------------------------------------------------------------------------

# 56. Keyboard Shortcuts

Global:

``` text
Ctrl + K      Command Palette
Ctrl + P      Open Project
Ctrl + T      New Terminal
Ctrl + ,      Settings
Ctrl + N      New Project
Ctrl + Shift + S  Start All Services
Ctrl + Shift + R  Restart Services
```

Navigation:

``` text
Alt + 1       Home
Alt + 2       Runtimes
Alt + 3       Servers
Alt + 4       Sites
Alt + 5       Databases
```

Context-specific shortcuts may be added later.

Shortcuts must never conflict with terminal input.

------------------------------------------------------------------------

# 57. Search Behavior

Search should be globally available.

Ranking:

``` text
1. Exact name
2. Prefix match
3. Fuzzy name
4. Type
5. Path
6. Tags
```

Example:

Searching:

``` text
larav
```

could return:

``` text
Projects
  laravel-app

Sites
  laravel.test

Commands
  php artisan
```

------------------------------------------------------------------------

# 58. Responsive Window Behavior

At wide widths:

``` text
Sidebar | Main | Right Rail
```

At medium widths:

``` text
Sidebar | Main
```

At narrow desktop widths:

``` text
Collapsed Sidebar | Main
```

Do not allow critical content to become unreadably narrow.

Use horizontal scrolling for:

-   tables
-   terminal
-   code/configuration
-   logs

------------------------------------------------------------------------

# 59. Dense Mode

Developer applications benefit from a compact mode.

Normal:

``` text
row height: 52–60px
```

Compact:

``` text
row height: 40–44px
```

Dense mode should reduce:

-   vertical padding
-   card spacing
-   row height

It should not reduce:

-   text legibility
-   click targets below usability thresholds
-   focus visibility

------------------------------------------------------------------------

# 60. Tables

Tables are preferred for highly structured management views.

Columns should be:

-   sortable
-   resizable where useful
-   searchable
-   filterable

Example:

``` text
Runtime | Version | Status | Default | Path | Actions
```

Use sticky headers for long lists.

Rows:

``` text
hover → subtle background
selected → accent-soft
```

------------------------------------------------------------------------

# 61. Filters

Filters should use compact controls.

Examples:

``` text
[All Types ▼]
[Running ▼]
[All Versions ▼]
```

Active filter:

``` text
Running ×
```

Provide:

``` text
Clear filters
```

when multiple filters are active.

------------------------------------------------------------------------

# 62. Cards

Card anatomy:

``` text
┌─────────────────────────────┐
│ Icon  Title             ... │
│       Subtitle              │
│                             │
│ Main value                  │
│                             │
│ ● Status            Action  │
└─────────────────────────────┘
```

Cards should have a clear visual hierarchy.

Do not put 10 different actions directly into the card.

Use overflow menus.

------------------------------------------------------------------------

# 63. Page Headers

Every major page should use:

``` text
Title
Description
                    Primary Action
```

Example:

``` text
Runtime Manager
Install, switch, and manage language runtimes.

                              + Install Runtime
```

Below:

``` text
Search / filters / tabs
```

------------------------------------------------------------------------

# 64. Tabs

Use tabs when information belongs to the same entity.

Example:

``` text
Overview | Logs | Configuration | Environment
```

Tab height:

``` text
36–40px
```

Active tab:

-   accent text
-   subtle underline or bottom indicator

Avoid giant segmented controls.

------------------------------------------------------------------------

# 65. Status Badges

Examples:

``` text
● Running
● Active
● Stopped
● Installing
● Error
```

Badge design:

``` text
font: 11–12px
radius: 999px
padding: 3px 8px
```

Status badge should never be the only indicator of state.

Use text plus icon/dot.

------------------------------------------------------------------------

# 66. Environment Variable UI

Table:

``` text
KEY             VALUE                 SOURCE
APP_ENV         local                 Project
APP_DEBUG       true                  Project
DB_HOST         127.0.0.1             Project
DB_PASSWORD    ••••••••••             Secret
```

Editable row interaction:

``` text
click → inline edit
Enter → save
Esc → cancel
```

Provide a dedicated "Edit .env" mode if users need bulk editing.

------------------------------------------------------------------------

# 67. Configuration Editor

For configuration files, use a code editor.

Recommended:

``` text
Monaco Editor
```

Potential languages:

``` text
JSON
YAML
TOML
INI
Nginx
Apache
.env
Shell
Rust
JavaScript
TypeScript
```

Features:

-   syntax highlighting
-   search
-   format
-   save
-   dirty indicator
-   reset
-   validation where possible

------------------------------------------------------------------------

# 68. Rust ↔ React State Model

The UI should treat Rust as the source of truth for system state.

Suggested conceptual event model:

``` text
RuntimeStarted
RuntimeStopped
RuntimeInstalled
RuntimeRemoved

ServerStarted
ServerStopped
ServerError

SiteCreated
SiteRemoved

DatabaseStarted
DatabaseStopped

ProjectCreated
ProjectOpened

TerminalStarted
TerminalExited

SystemStatsUpdated
```

React subscribes to events.

Do not poll aggressively if Rust can push events.

------------------------------------------------------------------------

# 69. Async Operation Model

Represent operations like:

``` ts
type OperationStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled";
```

Operation object:

``` ts
interface Operation {
  id: string;
  type: string;
  label: string;
  status: OperationStatus;
  progress?: number;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}
```

Use this model for:

-   installs
-   starts
-   stops
-   project creation
-   imports
-   exports
-   updates

------------------------------------------------------------------------

# 70. Rust Event Design

Prefer structured events instead of raw strings.

Conceptually:

``` rust
enum AppEvent {
    RuntimeUpdated(Runtime),
    ServerUpdated(Server),
    SiteUpdated(Site),
    DatabaseUpdated(Database),
    ProjectUpdated(Project),
    OperationUpdated(Operation),
    SystemStats(SystemStats),
    TerminalOutput(TerminalOutput),
}
```

The exact implementation is an engineering decision, but the UI should
receive structured state.

------------------------------------------------------------------------

# 71. Frontend Architecture

Recommended React structure:

``` text
src/
├── app/
│   ├── router/
│   ├── providers/
│   └── layout/
│
├── components/
│   ├── ui/
│   ├── layout/
│   ├── navigation/
│   ├── feedback/
│   ├── forms/
│   ├── terminal/
│   └── charts/
│
├── features/
│   ├── dashboard/
│   ├── runtimes/
│   ├── servers/
│   ├── sites/
│   ├── databases/
│   ├── containers/
│   ├── environment/
│   ├── projects/
│   ├── tools/
│   ├── extensions/
│   └── settings/
│
├── hooks/
├── stores/
├── services/
├── lib/
├── types/
└── styles/
```

Feature components should own feature-specific UI.

Avoid one enormous `Dashboard.tsx`.

------------------------------------------------------------------------

# 72. Component Naming

Use semantic names.

Good:

``` text
RuntimeCard
RuntimeList
RuntimeStatus
RuntimeInstallDialog
ServerCard
ServerLogs
ProjectCard
ProjectEnvironment
TerminalPanel
CommandPalette
SystemResourceCard
```

Avoid:

``` text
Box1
Card2
Thing
PanelA
```

------------------------------------------------------------------------

# 73. Design Tokens in CSS

Centralize design tokens.

Example:

``` css
:root {
  --color-bg-app: #0E0E0F;
  --color-bg-surface: #141415;
  --color-bg-elevated: #1F1F20;

  --color-border: #373738;

  --color-text-primary: #F7F7F8;
  --color-text-secondary: #B2B2B3;
  --color-text-muted: #7C7C7D;

  --color-accent: #FF6B5A;
  --color-success: #32D583;
  --color-warning: #F5B942;
  --color-danger: #FF5D73;

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
}
```

All components should use tokens.

------------------------------------------------------------------------

# 74. Theme Architecture

Use semantic variables.

Do not write:

``` css
background: #0E0E0F;
```

inside dozens of components.

Prefer:

``` css
background: var(--color-bg-app);
```

Theme changes should be handled centrally.

------------------------------------------------------------------------

# 75. React State Principles

Separate:

### Server state

Data originating from Rust:

-   runtimes
-   servers
-   projects
-   sites
-   databases
-   system stats

### UI state

Local frontend state:

-   modal open
-   selected tab
-   sidebar collapsed
-   command palette open
-   filter state
-   terminal panel size

Do not mix them unnecessarily.

------------------------------------------------------------------------

# 76. Optimistic UI

Use optimistic UI only when the outcome is highly predictable.

For service lifecycle operations, prefer:

``` text
user clicks Start
→ UI shows Starting
→ Rust confirms
→ UI shows Running
```

Do not immediately show Running.

------------------------------------------------------------------------

# 77. Notifications and Error Handling

Every Rust command should return structured errors.

Conceptual:

``` rust
struct AppError {
    code: String,
    message: String,
    details: Option<String>,
    recoverable: bool,
    action: Option<String>,
}
```

React maps these to human-readable messages.

Do not expose raw Rust panic messages in normal UI.

------------------------------------------------------------------------

# 78. Security UX

Because DevBox manages local processes and potentially credentials:

-   never display secrets by default
-   avoid logging secret values
-   confirm privileged operations
-   make destructive operations explicit
-   show filesystem paths before destructive actions
-   distinguish "remove from DevBox" from "delete files"
-   never silently modify unrelated project files
-   show when administrator privileges are required

------------------------------------------------------------------------

# 79. First Launch Experience

First launch should not look like an empty dashboard.

Show:

``` text
Welcome to DevBox

Let's prepare your development environment.

[Scan Existing Runtimes]
[Install Recommended Setup]
[Start Empty]
```

Scan should discover:

-   PHP
-   Node
-   Python
-   Git
-   Docker
-   package managers
-   existing projects

Do not automatically install anything without consent.

------------------------------------------------------------------------

# 80. Onboarding

Recommended onboarding:

``` text
1. Detect environment
2. Choose runtimes
3. Choose default project folder
4. Configure shell
5. Finish
```

Allow skipping.

------------------------------------------------------------------------

# 81. First Dashboard State

After installation:

``` text
Good evening

Your environment is ready.

0 runtimes
0 sites
0 projects

[Install Runtime]
[Create Project]
[Import Existing Project]
```

This is better than showing empty cards with zeroes everywhere.

------------------------------------------------------------------------

# 82. Existing Project Import

Flow:

``` text
Import Project
↓
Choose Folder
↓
Detect Framework
↓
Detected: Laravel
↓
Detected PHP requirement: ^8.2
↓
Select PHP 8.3
↓
Configure Site
↓
Import
```

Detection results should be editable.

------------------------------------------------------------------------

# 83. Project Detection

Potential detection:

``` text
Laravel
Next.js
Nuxt
Vite
React
Vue
Angular
Django
Flask
Rails
WordPress
Generic PHP
Generic Node
```

The UI should not assume detection is always correct.

Provide:

``` text
Detected automatically
[Change]
```

------------------------------------------------------------------------

# 84. Developer-Friendly Copywriting

Tone:

-   concise
-   confident
-   technical
-   helpful
-   never childish

Good:

> Nginx is already using port 80.

Bad:

> Oops! Something went wrong! 😅

Good:

> PHP 8.3 is required by this project.

Bad:

> Your PHP thing seems broken.

Use verbs:

``` text
Start
Stop
Restart
Install
Remove
Open
Configure
Inspect
Connect
Create
Import
Export
```

------------------------------------------------------------------------

# 85. Dashboard Quote / Brand Detail

A subtle brand statement may appear at the bottom of the dashboard:

> Better tools. Faster development. Greater possibilities.

It should be low visual priority.

Do not make it the focal point.

------------------------------------------------------------------------

# 86. Background Effects

The ambient background is a particle field. It may use:

``` text
subtle particles
very slow light movement
```

No background gradients, no blurred orbs, no glow. The effect never carries
meaning and never becomes the point of the screen.

Recommended opacity:

``` text
0.05–0.18
```

Never reduce text contrast to make effects visible.

------------------------------------------------------------------------

# 87. No Glow

The product does not use glow.

There is no glow token, no glow utility and no glow in any state: not on the
primary CTA, not on active navigation, not on focus, not on a running state,
not on a selected project, not on the command palette, not in the ambient
background. Depth is shadow alone.

Emphasis is carried by primitives the product already has:

``` text
primary CTA          accent fill
active navigation    raised background, thin accent line, accent icon, contrast
focus                2px accent ring, 2px offset
running state        a status dot plus a label that states the state
command palette      the glass panel over a dimmed backdrop
```

Do not reintroduce it. The product should feel premium, not like a gaming UI.

------------------------------------------------------------------------

# 88. Visual Density

DevBox should be more information-dense than a typical SaaS dashboard.

Target:

``` text
Developer workstation
rather than
Marketing dashboard
```

Prefer:

``` text
compact rows
small labels
clear metadata
secondary information
quick actions
```

But preserve hierarchy.

------------------------------------------------------------------------

# 89. Information Hierarchy

Every component should answer:

### Level 1

What is this?

### Level 2

What is its current state?

### Level 3

What can I do?

### Level 4

What additional information is available?

Example:

``` text
PHP
8.3.12
● Running

[Toggle]

Path
C:\DevBox\runtimes\php\8.3.12
```

------------------------------------------------------------------------

# 90. Progressive Disclosure

Default UI:

``` text
80% common actions
20% advanced actions
```

Advanced:

``` text
configuration
paths
environment
diagnostics
raw logs
advanced networking
```

Hide advanced settings behind:

``` text
Advanced
```

Do not overwhelm first-time users.

------------------------------------------------------------------------

# 91. Contextual Actions

Actions should appear close to the thing they affect.

Example:

Runtime:

``` text
PHP 8.3
[Toggle] [...]
```

Project:

``` text
laravel-app
[Open] [Terminal] [...]
```

Site:

``` text
laravel.test
[Open Browser] [...]
```

Avoid forcing the user into a detail page for simple operations.

------------------------------------------------------------------------

# 92. Command Palette as Power Layer

The command palette is the power-user interface.

Everything important should eventually be commandable.

Examples:

``` text
Start PHP 8.3
Stop Nginx
Restart MySQL
Open laravel.test
Open terminal in laravel-app
Install Node 22
Set PHP 8.3 as default
Clear DevBox cache
Open settings
```

Commands should support fuzzy search.

------------------------------------------------------------------------

# 93. Context-Aware Command Palette

If the current page is:

``` text
/projects/laravel-app
```

show project-specific commands first:

``` text
Open Terminal
Start Services
Open Site
Open Folder
Restart Project
Edit Environment
```

This dramatically improves power-user efficiency.

------------------------------------------------------------------------

# 94. Tooltips

Use tooltips for:

-   icon-only buttons
-   unfamiliar actions
-   truncated paths
-   keyboard shortcuts

Do not tooltip obvious text buttons.

Tooltip delay:

``` text
350–500ms
```

------------------------------------------------------------------------

# 95. Truncation

Long paths should truncate intelligently.

Example:

``` text
C:\Users\Developer\...\laravel-app
```

Tooltip shows full path.

Project names should not be truncated unless necessary.

------------------------------------------------------------------------

# 96. File Paths

Use monospace for paths:

``` text
C:\Users\Developer\Dev\laravel-app
```

Paths should be selectable/copyable.

Use a copy button when useful.

------------------------------------------------------------------------

# 97. Code and Logs

All technical content should use:

``` text
JetBrains Mono
```

Examples:

``` text
php artisan serve
npm run dev
127.0.0.1:8000
```

Use a slightly darker surface behind code.

------------------------------------------------------------------------

# 98. Notification Center

Optional notification panel:

``` text
Notifications

● PHP 8.3 installed
  2 minutes ago

● Nginx failed to start
  5 minutes ago

○ Update available
  DevBox 2.1.1
```

Allow:

``` text
Mark all read
Clear
```

Errors should remain visible until acknowledged if important.

------------------------------------------------------------------------

# 99. System Tray

Desktop application should support system tray where platform
integration allows it.

Tray menu:

``` text
DevBox

● 6 services running

Open DevBox
Start All Services
Stop All Services
Open Terminal
Quit
```

Do not make quitting ambiguous.

------------------------------------------------------------------------

# 100. Window Controls

Respect native desktop window conventions.

If custom titlebar is used:

-   preserve draggable area
-   preserve minimize/maximize/close
-   support double-click titlebar
-   preserve accessibility
-   avoid decorative controls near native window buttons

Do not imitate macOS controls on Windows.

------------------------------------------------------------------------

# 101. Startup Performance

The UI should appear immediately.

Use:

``` text
Shell
↓
Render skeleton
↓
Load persisted UI state
↓
Connect to Rust
↓
Receive system state
↓
Hydrate views
```

Do not block the entire UI waiting for every runtime to load.

------------------------------------------------------------------------

# 102. Lazy Loading

Lazy-load:

-   settings
-   extensions
-   large configuration editors
-   database explorer
-   terminal modules
-   heavy charts

Dashboard core should load quickly.

------------------------------------------------------------------------

# 103. Terminal Performance

Terminal output can be extremely high volume.

Requirements:

-   virtualize output where necessary
-   avoid React state update per character
-   batch output
-   keep PTY processing in Rust
-   throttle UI rendering
-   cap retained scrollback if necessary

The terminal must not freeze the rest of the application.

------------------------------------------------------------------------

# 104. Log Performance

Same principle.

Do not append every line through a full component tree re-render.

Use:

``` text
buffer
batch
render
```

------------------------------------------------------------------------

# 105. Charts

Charts should be subtle.

Preferred:

-   line chart
-   area chart
-   compact radial gauge

Avoid:

-   3D charts
-   pie charts for trivial information
-   excessive legends
-   highly saturated chart colors

Charts should communicate system state, not decorate the dashboard.

------------------------------------------------------------------------

# 106. Data Refresh

Use event-driven updates where possible.

For metrics:

``` text
CPU: ~1s
RAM: ~1s
Disk: ~5–10s
```

For static metadata:

``` text
on demand
```

Do not continuously refresh expensive data.

------------------------------------------------------------------------

# 107. Offline / Local-First UX

DevBox should remain useful without internet.

Clearly distinguish:

``` text
Local operation
```

from:

``` text
Online operation
```

Example:

> PHP 8.3 is available locally.

vs.

> Downloading PHP 8.3 from the configured mirror...

Do not imply cloud dependency.

------------------------------------------------------------------------

# 108. Update UI

Application update card:

``` text
DevBox 2.1.1 available

Current: 2.1.0

[View Changes] [Update]
```

Runtime updates should be separate from application updates.

------------------------------------------------------------------------

# 109. Diagnostics

Provide a diagnostics page or dialog.

Information:

``` text
DevBox version
Rust core version
OS
Architecture
Shell
PATH
Runtime directories
Config directory
Log directory
```

Actions:

``` text
Copy Diagnostics
Open Logs
Open Config Folder
```

Never include secret environment values.

------------------------------------------------------------------------

# 110. Port Inspector

A useful dedicated utility:

``` text
Port Inspector

Port     Process       PID      Status
80       nginx         8124     Listening
3306     mysqld        9021     Listening
5173     node          3321     Listening
8000     php           1421     Listening
```

Actions:

``` text
Inspect
Stop Process
Copy PID
```

Stopping arbitrary processes should require confirmation.

------------------------------------------------------------------------

# 111. Hosts Manager

Optional utility:

``` text
Hosts

127.0.0.1   laravel.test
127.0.0.1   nextjs.local
127.0.0.1   api.local
```

Actions:

``` text
Add
Edit
Remove
Flush DNS
```

Privileged operations should be clearly communicated.

Scope: this manager lists the entries DevX itself wrote — the lines carrying
its marker — and never the file's other lines. Those belong to the user and to
the system, and the helper is only allowed to add, update and remove its own,
so a panel that showed them would be offering edits it must refuse. The same
limit is worth saying in the UI: a list presented as "the hosts file" would
read as a claim about lines nobody here can touch.

Entries are keyed by host name, so Edit is an add of the new name followed by
a remove of the old one when the name changes; an address-only change is a
single in-place update. Flush DNS drops the machine's whole resolver cache,
not just these names, because a name that already resolved keeps resolving
from the cache after the file changed.

------------------------------------------------------------------------

# 112. Certificates

Local HTTPS management:

``` text
Certificates

laravel.test
✓ Valid
Expires: ...

nextjs.local
✓ Valid
```

Actions:

``` text
Generate
Trust
Renew
Remove
```

Never make certificate operations feel mysterious.

------------------------------------------------------------------------

# 113. Project Quick Actions

Project detail top-right:

``` text
[Open Browser]
[Terminal]
[Open Folder]
[Restart]
[...]
```

The primary action depends on project type.

For web projects:

``` text
Open Browser
```

For CLI projects:

``` text
Open Terminal
```

------------------------------------------------------------------------

# 114. Project Status

Example:

``` text
laravel-app

● Healthy

PHP 8.3.12
Node 22.14
Nginx
MySQL
Redis

laravel.test
```

If one dependency fails:

``` text
● Attention required

MySQL is stopped.
```

The project status should aggregate child states.

------------------------------------------------------------------------

# 115. Project Environment Presets

Allow:

``` text
Local
Testing
Staging-like
Custom
```

Do not automatically create staging infrastructure.

Presets should primarily manage local environment
variables/configuration.

------------------------------------------------------------------------

# 116. Project Scripts

Display common scripts:

``` text
dev
build
test
lint
format
```

Example:

``` text
npm run dev

[Run]
```

For Laravel:

``` text
php artisan serve
php artisan migrate
php artisan queue:work
```

Scripts can be detected from project metadata.

------------------------------------------------------------------------

# 117. Quick Action Cards

Dashboard actions:

``` text
New Project
Add Runtime
Add Site
Open Terminal
```

Each card:

-   icon
-   title
-   subtitle
-   shortcut

Example:

``` text
＋ New Project
Create a new project
Ctrl + N
```

------------------------------------------------------------------------

# 118. System Status

Bottom-left sidebar status:

``` text
● System Ready
  All services are running
```

States:

``` text
System Ready
Attention Required
System Error
Starting
Stopping
```

Clicking status should open a diagnostic summary.

------------------------------------------------------------------------

# 119. Global Status Model

Conceptually:

``` text
healthy
warning
error
busy
offline
unknown
```

Never overload one state with multiple meanings.

------------------------------------------------------------------------

# 120. Design Anti-Patterns

Do not implement:

### 1. Glow

The product has none, in any state. Emphasis comes from border, contrast and
position, never from emitted light.

### 2. Huge cards

Dev tools require density.

### 3. Every action as a button

Use overflow menus.

### 4. Excessive animation

Developer tools should feel fast.

### 5. Pure black background

Use dark graphite.

### 6. Pure white text everywhere

Use hierarchy.

### 7. Rainbow gradients

Use coral/cyan sparingly.

### 8. Giant hero section

This is software, not a marketing landing page.

### 9. Modal for every action

Simple operations should be inline.

### 10. Hidden system state

Always communicate running/stopped/error state.

------------------------------------------------------------------------

# 121. Component State Checklist

Every interactive component should consider:

``` text
default
hover
active
focus
disabled
loading
success
warning
error
selected
```

For data components additionally:

``` text
empty
skeleton
partial
stale
offline
```

------------------------------------------------------------------------

# 122. UX Acceptance Criteria

A design is considered successful if a developer can:

### Runtime

-   find PHP in \< 2 seconds
-   see its version
-   see whether it is running
-   start/stop it
-   change default version

### Project

-   open a project in \< 2 seconds
-   open terminal in \< 2 clicks
-   open local site in \< 2 clicks

### Services

-   identify failed services immediately
-   restart a service quickly
-   inspect logs without navigating through multiple screens

### Environment

-   find `.env` variables quickly
-   hide/reveal secrets
-   edit values safely

### Command palette

-   execute common commands without mouse
-   fuzzy-find projects/runtimes

------------------------------------------------------------------------

# 123. UI Quality Bar

Before considering a page complete, verify:

-   [ ] Typography follows the design system.
-   [ ] Spacing follows the 4px grid.
-   [ ] Colors use semantic tokens.
-   [ ] Dark and light themes work.
-   [ ] Hover states exist.
-   [ ] Focus states exist.
-   [ ] Loading state exists.
-   [ ] Empty state exists.
-   [ ] Error state exists.
-   [ ] Success feedback exists.
-   [ ] Destructive actions are confirmed.
-   [ ] Keyboard navigation works.
-   [ ] Tooltips exist for icon-only actions.
-   [ ] Long paths are handled.
-   [ ] Window resizing works.
-   [ ] Reduced motion is respected.
-   [ ] No unnecessary animation exists.

------------------------------------------------------------------------

# 124. Implementation Priority

Build in this order.

## Phase 1 --- Design foundation

``` text
Theme
Tokens
Typography
Icons
Buttons
Inputs
Cards
Badges
Dialogs
Toast
Tooltip
Tabs
Dropdowns
```

## Phase 2 --- Application shell

``` text
Sidebar
Topbar
Search
Command palette
Status system
Theme switching
```

## Phase 3 --- Dashboard

``` text
Summary
Runtimes
Servers
Sites
Databases
Projects
System resources
Activity
Terminal
```

## Phase 4 --- Core management

``` text
Runtime Manager
Server Manager
Sites Manager
Database Manager
Project Manager
Environment Manager
```

## Phase 5 --- Power features

``` text
Terminal
Command palette
Port inspector
Hosts manager
Certificates
Diagnostics
Tools
Extensions
```

## Phase 6 --- Polish

``` text
Micro-interactions
Background effects
Performance
Keyboard shortcuts
Accessibility
Empty/loading/error states
```

------------------------------------------------------------------------

# 125. Recommended React Component Library

Use a consistent internal component layer.

Suggested primitives:

``` text
Button
IconButton
Input
SearchInput
Select
Combobox
Checkbox
Switch
Radio
Tabs
Badge
Tooltip
Popover
DropdownMenu
Dialog
Drawer
Toast
Skeleton
Progress
Card
Table
DataList
CommandPalette
Breadcrumb
CodeEditor
Terminal
```

Build these once and reuse them.

------------------------------------------------------------------------

# 126. Recommended Feature Components

``` text
AppShell
Sidebar
Topbar
GlobalSearch

Dashboard
DashboardHeader
SystemStatus
QuickActions
SummaryCard
RuntimeOverview
ServerOverview
SiteOverview
DatabaseOverview
RecentProjects
RecentActivity
SystemResources
EnvironmentOverview

RuntimeManager
RuntimeCard
RuntimeTable
RuntimeDetail
RuntimeInstallDialog

ServerManager
ServerCard
ServerDetail
ServerLogs

SiteManager
SiteCard
SiteDetail
CreateSiteDialog

DatabaseManager
DatabaseCard
DatabaseDetail
DatabaseExplorer

ProjectManager
ProjectCard
ProjectDetail
CreateProjectWizard
ProjectEnvironment
ProjectScripts

TerminalPanel
TerminalTabs
TerminalToolbar

CommandPalette
```

------------------------------------------------------------------------

# 127. Recommended Interaction Architecture

All system actions should follow:

``` text
UI action
   ↓
React command/service layer
   ↓
Rust IPC command
   ↓
Rust operation
   ↓
Rust event
   ↓
React state update
   ↓
UI feedback
```

Example:

``` text
[Start Nginx]
      ↓
invoke("server_start", { id })
      ↓
Rust starts process
      ↓
ServerStarting
      ↓
UI = Starting
      ↓
ServerRunning
      ↓
UI = Running
```

------------------------------------------------------------------------

# 128. Avoid Direct System Logic in React

React should not:

-   spawn processes directly
-   manage ports
-   manipulate hosts files
-   manage runtime binaries
-   modify privileged files
-   determine actual service health

Those responsibilities belong to Rust.

React should request actions and render state.

------------------------------------------------------------------------

# 129. Visual Reference

The intended overall composition resembles a premium dark developer
desktop:

``` text
                     TOPBAR
┌──────────────┬──────────────────────────────────────┐
│              │ Search                 actions      │
│              ├──────────────────────────────────────┤
│              │                                      │
│   SIDEBAR    │ Dashboard                            │
│              │                                      │
│   Home       │ ┌────────┐ ┌────────┐ ┌────────┐    │
│   Runtimes   │ │Runtime │ │Server  │ │Sites   │    │
│   Servers    │ └────────┘ └────────┘ └────────┘    │
│   Sites      │                                      │
│   Databases  │ ┌────────────────┐ ┌─────────────┐  │
│   Containers │ │ Runtime Manager│ │Server Manager│  │
│   Environment│ │                │ │             │  │
│   Tools      │ └────────────────┘ └─────────────┘  │
│              │                                      │
│   PROJECTS   │ ┌─────────────┐ ┌───────────────┐   │
│   project-a  │ │Sites        │ │System Resource│   │
│   project-b  │ └─────────────┘ └───────────────┘   │
│              │                                      │
│   ● Ready    │ ┌─────────────────────────────────┐ │
│              │ │ Terminal                        │ │
└──────────────┴─┴─────────────────────────────────┴─┘
```

------------------------------------------------------------------------

# 130. Final Design Rule

When deciding between two UI implementations, prefer the one that:

1.  communicates state faster,
2.  requires fewer clicks,
3.  exposes less unnecessary complexity,
4.  preserves keyboard accessibility,
5.  performs well,
6.  looks calm,
7.  works in both dark and light mode,
8.  remains understandable at high information density.

The application should feel like:

> **A powerful local development machine distilled into one elegant
> interface.**

Not:

> **A collection of settings pages.**

------------------------------------------------------------------------

# 131. Agent Implementation Rules

This section is specifically intended for an AI coding agent.

## Rule 1 --- Treat this document as the visual source of truth

Do not invent a new visual language for individual pages.

## Rule 2 --- Reuse primitives

If a Button, Card, Dialog, Table, Badge, or Input already exists, reuse
it.

Do not create a one-off equivalent.

## Rule 3 --- Use design tokens

Never hard-code colors when a semantic token exists.

## Rule 4 --- Preserve information hierarchy

Do not add visual emphasis to secondary metadata.

## Rule 5 --- Keep desktop density

Do not turn management pages into oversized mobile-style cards.

## Rule 6 --- State is more important than decoration

Running/stopped/error/loading states must always be obvious.

## Rule 7 --- Every async operation needs feedback

Never let a click appear to do nothing.

## Rule 8 --- Rust owns system truth

Do not fake system status in React.

## Rule 9 --- Avoid unnecessary dependencies

Only introduce a UI library when it solves a real problem and fits the
visual system.

## Rule 10 --- Keep components composable

Prefer:

``` text
<Card>
  <CardHeader />
  <CardContent />
  <CardFooter />
</Card>
```

over giant page-specific components.

## Rule 11 --- Test states

Every new feature should include:

``` text
loading
empty
success
error
disabled
```

where applicable.

## Rule 12 --- Keyboard first

If an action can reasonably have a keyboard shortcut, support it.

## Rule 13 --- Do not add glow

The product uses none, and no new component introduces it.

## Rule 14 --- Do not use effects as a substitute for hierarchy

Hierarchy must come from:

``` text
spacing
typography
contrast
surface elevation
```

## Rule 15 --- Preserve light theme

Every new component must work in both themes.

## Rule 16 --- Respect reduced motion

Every animated component needs a reduced-motion fallback.

## Rule 17 --- No fake data in production UI

Mock data is acceptable during development, but clearly isolate it and
make the real Rust integration straightforward.

## Rule 18 --- Do not hide errors

Errors must be visible and actionable.

## Rule 19 --- Avoid unnecessary confirmation dialogs

Use confirmation only when the action has meaningful consequences.

## Rule 20 --- Build the product as a desktop application

Do not make the UI feel like a web admin template.

------------------------------------------------------------------------

# 132. Definition of Done

A page is complete when:

``` text
✓ Correct layout
✓ Correct typography
✓ Correct colors
✓ Correct spacing
✓ Correct iconography
✓ Dark mode
✓ Light mode
✓ Loading state
✓ Empty state
✓ Error state
✓ Success feedback
✓ Keyboard interaction
✓ Hover/focus states
✓ Window resizing
✓ Accessibility
✓ Reduced motion
✓ Rust integration boundary
✓ No console errors
✓ No unnecessary re-renders
✓ No visual regressions
```

------------------------------------------------------------------------

# 133. Brand Personality

DevBox should feel:

``` text
80% professional developer tool
15% premium desktop application
5% futuristic visual polish
```

Not:

``` text
50% gaming UI
30% SaaS dashboard
20% developer tool
```

The futuristic visual layer should be nearly invisible and only add subtle polish. The product must never look like a gaming or neon UI.

------------------------------------------------------------------------

# 134. Final Visual Summary

Use this mental model when implementing every screen:

``` text
DARK GRAPHITE
     +
CLEAN SURFACES
     +
CORAL ACCENT
     +
OPTIONAL CYAN SECONDARY
     +
SOFT STATUS COLORS
     +
INTER TYPOGRAPHY
     +
JETBRAINS MONO
     +
COMPACT DENSITY
     +
MINIMAL VISUAL EFFECTS
     +
SUBTLE AMBIENT MOTION
     +
FAST MICRO-INTERACTIONS
     +
CLEAR SYSTEM STATE
     =
DEVBOX
```

The final product should feel **fast before it feels flashy**.

The most important visual effect is not the particle background.

It is the feeling that:

> **Everything on this machine is under control.**

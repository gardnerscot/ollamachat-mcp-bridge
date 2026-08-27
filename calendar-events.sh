#!/bin/bash
# calendar-events.sh — list macOS Calendar.app events for a day range.
# Usage: calendar-events.sh [today|tomorrow|week]   (anything unknown → today)
# Reads every calendar the Mac syncs (Google, iCloud, work) — no OAuth needed.
# NOTE: output order is by calendar, not chronological; AppleScript filters by start date.

_cal_scan() {
  local RANGE="${1:-today}"
  local OFFSET COUNT
  case "$RANGE" in
    today)    OFFSET=0; COUNT=1 ;;
    tomorrow) OFFSET=1; COUNT=1 ;;
    week)     OFFSET=0; COUNT=7 ;;
    *)        OFFSET=0; COUNT=1 ;;
  esac

  osascript - "$OFFSET" "$COUNT" <<'APPLESCRIPT'
on run argv
  set offsetDays to (item 1 of argv) as integer
  set dayCount to (item 2 of argv) as integer

  set midnight to (current date)
  set time of midnight to 0
  set startDate to midnight + offsetDays * days
  set endDate to startDate + dayCount * days

  set dayLabel to "today"
  if offsetDays is 1 then set dayLabel to "tomorrow"
  if dayCount > 1 then set dayLabel to "next " & dayCount & " days"

  -- junk calendar names left over from a decade of subscriptions; skip them for speed
  set junkBits to {"webinar", "EventAppt", "ZohoConnect", "Holiday", "holidays", "Birthdays", "Siri Suggestions", "Apple Store", "iPhone", "iPad"}

  set out to ""
  tell application "Calendar"
    repeat with cal in calendars
      try
        set calName to name of cal
        set isJunk to false
        repeat with bit in junkBits
          if calName contains (bit as string) then set isJunk to true
        end repeat
        if isJunk then error "skip"
        set evs to (every event of cal whose start date >= startDate and start date < endDate)
        repeat with ev in evs
          set evSummary to summary of ev
          set evStart to start date of ev
          set dateBits to (word 1 of (weekday of evStart as string)) & " " & (month of evStart as integer) & "/" & (day of evStart)
          set evLine to dateBits & " " & (time string of evStart) & " | " & evSummary & " | " & calName
          try
            if (location of ev) is not "" then set evLine to evLine & " | " & (location of ev)
          end try
          try
            if (allday event of ev) is true then set evLine to "ALL DAY | " & evLine
          end try
          set out to out & evLine & linefeed
        end repeat
      end try
    end repeat
  end tell

  if out is "" then return "No events " & dayLabel
  return out
end run
APPLESCRIPT
}

# dedupe identical lines (same Google cal mounted under multiple accounts)
_cal_scan "$@" 2>/dev/null | awk 'NF' | sort -u

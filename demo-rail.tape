Output demo-rail.gif
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 20
Set LetterSpacing 0
Set LineHeight 1.2
Set Theme "tokyonight"
Set Width 2000
Set Height 1150
Set Padding 12
Set Margin 6
Set MarginFill "#1a1b26"
Set BorderRadius 8
Set WindowBar "Colorful"
Set WindowBarSize 28
Set TypingSpeed 8ms
Set Framerate 20
Set PlaybackSpeed 1.4
Set Shell "bash"

# FULLSCREEN RAIL (sidebar on the right)
Type "pi --extension './src'" Enter
Sleep 5s

# Add notes from the chat
Type "/notes add Ask about migration ordering" Enter
Sleep 1.2s
Type "/notes add The flaky test is probably the fixture" Enter
Sleep 1.2s
Type "/notes add Check release notes before deploy" Enter
Sleep 1.2s
Type "/notes add Refactor auth middleware" Enter
Sleep 1.2s

# Collapse the whole rail block
Type "/notes collapse" Enter
Sleep 1.5s

# Expand it back
Type "/notes expand" Enter
Sleep 1.5s

# Fold every note to one line
Type "/notes fold" Enter
Sleep 1.5s

# Full text back
Type "/notes unfold" Enter
Sleep 1.5s

# Send two notes
Type "/notes send" Enter
Sleep 1s
Type "1" Enter
Sleep 1.5s
Type "/notes send" Enter
Sleep 1s
Type "1" Enter
Sleep 1.5s

# Restore one sent note back to pending
Type "/notes restore" Enter
Sleep 1s
Type "1" Enter
Sleep 1.5s

# Delete one note
Type "/notes delete 1" Enter
Sleep 1.2s

# Send the restored note again — back to sent
Type "/notes send" Enter
Sleep 1s
Type "1" Enter
Sleep 1.5s

# Final list: rail shows pending + sent struck through
Type "/notes list" Enter
Sleep 2.5s

# Manager
Type "alt+n" Enter
Sleep 1.2s
Type "q" Enter
Sleep 0.5s

# Clean up
Type "/notes clear sent" Enter
Sleep 1s
Type "y" Enter
Sleep 1s
Type "/notes clear" Enter
Sleep 1s
Type "y" Enter
Sleep 1s

Type "/exit" Enter
Sleep 1.5s

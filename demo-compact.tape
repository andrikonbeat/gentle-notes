Output demo-compact.gif
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 28
Set LetterSpacing 0
Set LineHeight 1.2
Set Theme "tokyonight"
Set Width 1100
Set Height 700
Set Padding 16
Set Margin 6
Set MarginFill "#1a1b26"
Set BorderRadius 8
Set WindowBar "Colorful"
Set WindowBarSize 32
Set TypingSpeed 8ms
Set Framerate 20
Set PlaybackSpeed 1.4
Set Shell "bash"

# COMPACT MODE (regular resolution, note above chat input)
Type "pi --extension './src'" Enter
Sleep 5s

# One note: compact line appears above the chat input
Type "/notes add First note in compact mode" Enter
Sleep 1.2s

# Second note: the preview updates
Type "/notes add Second note expands the view" Enter
Sleep 1.2s

# Expand to the full list
Type "/notes expand" Enter
Sleep 2s

# Show the list
Type "/notes list" Enter
Sleep 2.5s

# Fold view
Type "/notes fold" Enter
Sleep 1.2s

# Unfold
Type "/notes unfold" Enter
Sleep 1.2s

# Send one from the expanded list
Type "/notes send" Enter
Sleep 1s
Type "1" Enter
Sleep 1.5s

# Restore it
Type "/notes restore" Enter
Sleep 1s
Type "1" Enter
Sleep 1.5s

# Delete one
Type "/notes delete 2" Enter
Sleep 1.2s

# Manager
Type "alt+n" Enter
Sleep 1.2s
Type "q" Enter
Sleep 0.5s

# Collapse back to the single line
Type "/notes collapse" Enter
Sleep 1.2s

Type "/exit" Enter
Sleep 1.5s

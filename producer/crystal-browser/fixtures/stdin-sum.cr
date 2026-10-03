lines = STDIN.gets_to_end.lines
puts lines[1] if lines.size > 1
puts (lines.first? || "").split.map(&.to_i64).sum

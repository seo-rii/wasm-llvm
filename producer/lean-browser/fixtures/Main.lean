def main : IO Unit := do
  let stdin ← IO.getStdin
  let name := (← stdin.getLine).trimAscii.toString
  let nums := ((← stdin.getLine).trimAscii.toString.splitOn " ").filterMap String.toInt?
  IO.println s!"Hello, {name}!"
  IO.println s!"sum = {nums.foldl (· + ·) 0}"

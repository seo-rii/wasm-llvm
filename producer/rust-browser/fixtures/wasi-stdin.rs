use std::io::{self, BufRead};

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let count = lines.next().transpose()?.unwrap_or_default().parse::<usize>().unwrap_or(0);
    let values = lines.next().transpose()?.unwrap_or_default();
    let sum: i64 = values.split_whitespace().filter_map(|value| value.parse::<i64>().ok()).take(count).sum();
    println!("sum={sum}");
    println!("text={}", lines.next().transpose()?.unwrap_or_else(|| "<eof>".into()));
    println!("eof={}", lines.next().transpose()?.is_none());
    Ok(())
}

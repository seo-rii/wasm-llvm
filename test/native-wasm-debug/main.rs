static GLOBAL_BIAS: i32 = 3;

#[inline(never)]
fn accumulate(n: i32) -> i32 {
    let doubled = n * 2;
    if n <= 1 {
        return doubled + GLOBAL_BIAS;
    }

    let child = accumulate(n - 1);
    let result = doubled + child;
    std::hint::black_box(result)
}

fn main() {
    let seed = 3;
    let total = accumulate(seed);
    println!("rust-total={total}");
}
